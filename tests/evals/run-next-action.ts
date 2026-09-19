import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { analyzeNextAction } from '@memo/model'
import type { ModelConfig } from '@memo/contracts'
import { callModelApi } from '../../apps/desktop/src/main/task-api-provider'
import { callModelCli } from '../../apps/desktop/src/main/task-cli-provider'
import { nextActionEvaluationOrder } from '../fixtures/next-action-corpus'
async function main() {
  const args = process.argv.slice(2),
    option = (key: string, fallback = '') =>
      args.includes(key) ? (args[args.indexOf(key) + 1] ?? fallback) : fallback
  if (!args.includes('--live'))
    throw Error('LIVE_MODEL_REQUIRES_EXPLICIT_LIVE_FLAG')
  const provider = option('--provider', 'codex-cli') as ModelConfig['provider'],
    limit = Number(option('--limit', '360')),
    concurrency = Number(option('--concurrency', '1'))
  if (
    !['codex-cli', 'claude-cli', 'responses', 'chat-completions'].includes(
      provider,
    ) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 360 ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 4
  )
    throw Error('INVALID_EVAL_ARGUMENT')
  const config: ModelConfig = {
    provider,
    enabled: true,
    model: option('--model'),
    baseUrl: option('--base-url', 'https://api.openai.com/v1'),
    credentialId: '',
  }
  if (
    ['responses', 'chat-completions'].includes(provider) &&
    !process.env.BUGU_EVAL_API_KEY
  )
    throw Error('EVAL_API_KEY_REQUIRED')
  const output = resolve(
    option('--output', `test-results/next-action-eval/${Date.now()}`),
  )
  await mkdir(output, { recursive: true })
  const results: Array<{
    id: string
    family: string
    mode: string
    passed: boolean
    error?: string
    prediction?: unknown
    elapsedMs: number
    expected: unknown
  }> = []
  // Interleave modes so a smoke run covers classification, attribution and recommendation.
  const modes = ['classify-event', 'attribute-transition', 'recommend']
  const requested = option('--ids').split(',').filter(Boolean)
  const ordered = nextActionEvaluationOrder().filter(
    (c) => !requested.length || requested.includes(c.id),
  )
  if (requested.some((id) => !ordered.some((c) => c.id === id)))
    throw Error('UNKNOWN_EVAL_CASE')
  const planned = Math.min(limit, ordered.length)
  let consecutiveErrors = 0
  let cursor = 0
  let flush = Promise.resolve()
  async function worker() {
    while (cursor < planned && consecutiveErrors < 3) {
      const c = ordered[cursor++]!
      const started = Date.now()
      let passed = false,
        error: string | undefined,
        prediction: unknown
      try {
        const result = await analyzeNextAction(
          c.input,
          async (request) => {
            const response = await (['responses', 'chat-completions'].includes(
              provider,
            )
              ? callModelApi(config, request, process.env.BUGU_EVAL_API_KEY!)
              : callModelCli(config, request))
            try {
              prediction = JSON.parse(response)
            } catch {
              /* Invalid JSON remains an explicit validation failure. */
            }
            return response
          },
          AbortSignal.timeout(65000),
        )
        prediction = result
        passed =
          result.eventType === c.expected.type &&
          result.related === c.expected.related &&
          (!c.expected.targetIds ||
            (!c.expected.related
              ? result.targetIds.length === 0
              : result.targetIds[0] === c.expected.targetIds[0]))
        consecutiveErrors = 0
      } catch (e) {
        error =
          e instanceof Error && /^[A-Z_]+$/.test(e.message)
            ? e.message
            : 'MODEL_OR_VALIDATION_FAILED'
        consecutiveErrors++
      }
      results.push({
        id: c.id,
        family: c.family,
        mode: c.input.mode,
        passed,
        ...(error ? { error } : {}),
        ...(prediction ? { prediction } : {}),
        elapsedMs: Date.now() - started,
        expected: c.expected,
      })
      flush = flush.then(() =>
        writeFile(
          resolve(output, 'results.json'),
          JSON.stringify(results, null, 2),
        ),
      )
      await flush
      console.log(
        `${results.length}/${planned} ${c.id}: ${passed ? 'PASS' : (error ?? 'FAIL')}`,
      )
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  const report = {
    provider,
    concurrency,
    promptSourceSha256: createHash('sha256')
      .update(await readFile(resolve('packages/model/src/next-action.ts')))
      .digest('hex'),
    corpusSha256: createHash('sha256')
      .update(JSON.stringify(ordered.slice(0, planned)))
      .digest('hex'),
    retryCount: 0,
    usageAndCost: 'Provider CLI does not expose usage to this runner; unknown',
    model: config.model || 'CLI default',
    syntheticCases: true,
    planned,
    executed: results.length,
    passed: results.filter((r) => r.passed).length,
    familyCount: new Set(results.map((r) => r.family)).size,
    complete: results.length === planned,
    accuracy: results.filter((r) => r.passed).length / results.length,
    modes: Object.fromEntries(
      modes.map((mode) => {
        const rows = results.filter((r) => r.mode === mode)
        return [
          mode,
          { total: rows.length, passed: rows.filter((r) => r.passed).length },
        ]
      }),
    ),
    note: 'Synthetic fixture results only. Time/ordering variants are correlated and must not be counted as independent evidence of production accuracy.',
  }
  await writeFile(
    resolve(output, 'report.json'),
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report))
  if (!report.complete || report.accuracy < 0.99) process.exitCode = 1
}
void main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'EVAL_FAILED')
  process.exitCode = 1
})

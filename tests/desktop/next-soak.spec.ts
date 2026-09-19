import { test, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { host, ready, train, idle } from '../fixtures/next-workflow-client'

test('bounded workbench soak: stable resources and no background model amplification', async () => {
  const seconds = Number(process.env.BUGU_NEXT_SOAK_SECONDS ?? 60)
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 86400)
    throw Error('INVALID_SOAK_DURATION')
  test.setTimeout((seconds + 90) * 1000)
  const { app, page, cleanup } = await host()
  const samples: Array<{
    elapsedMs: number
    rssKiB: number
    cpuPercent: number
    latencyMs: number
    modelCalls: number
    windows: number
  }> = []
  const started = Date.now()
  try {
    await ready(page)
    const ids = await train(page)
    await page.evaluate((id) => window.memo.nextAction.inspect(id), ids[5]!)
    await idle(page)
    const baseline = await app.evaluate(
      () => globalThis.nextWorkflowTest.state().modelCalls,
    )
    const until = Date.now() + seconds * 1000
    while (Date.now() < until) {
      const before = Date.now()
      const status = await page.evaluate(async () => {
        for (let i = 0; i < 20; i++) {
          const result = await window.memo.nextAction.workbench()
          if (!result.ok) throw Error('WORKBENCH_FAILED')
        }
        return window.memo.nextAction.status()
      })
      expect(status.ok).toBe(true)
      const latencyMs = Date.now() - before
      const metrics = await app.evaluate(({ app, BrowserWindow }) => ({
        metrics: app
          .getAppMetrics()
          .map((m) => ({
            rss: m.memory.workingSetSize,
            cpu: m.cpu.percentCPUUsage,
          })),
        windows: BrowserWindow.getAllWindows().length,
        modelCalls: globalThis.nextWorkflowTest.state().modelCalls,
      }))
      samples.push({
        elapsedMs: Date.now() - started,
        rssKiB: metrics.metrics.reduce((a, m) => a + m.rss, 0),
        cpuPercent: metrics.metrics.reduce((a, m) => a + m.cpu, 0),
        latencyMs,
        modelCalls: metrics.modelCalls,
        windows: metrics.windows,
      })
      expect(metrics.modelCalls).toBe(baseline)
      expect(metrics.windows).toBe(1)
      expect(latencyMs).toBeLessThan(5000)
      await page.waitForTimeout(
        Math.min(10000, Math.max(0, until - Date.now())),
      )
    }
    // A coarse leak bound, not a claim that all transient RSS has been reclaimed.
    expect(samples.at(-1)!.rssKiB - samples[0]!.rssKiB).toBeLessThan(256 * 1024)
  } finally {
    await mkdir('test-results', { recursive: true })
    await writeFile(
      'test-results/next-action-soak.json',
      JSON.stringify(
        {
          requestedSeconds: seconds,
          observedMs: Date.now() - started,
          scope:
            'isolated renderer/preload/runtime/core/SQLite; model and app launch are fixture transports; no system observation permission',
          samples,
        },
        null,
        2,
      ),
    )
    await cleanup()
  }
})

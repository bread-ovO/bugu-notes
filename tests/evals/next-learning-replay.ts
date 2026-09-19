import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { canRecommend, learnedHabit, rankTargets } from '@memo/next-action'
import type { NextChoice, NextEvent, NextLearningData } from '@memo/contracts'
import { event, choice, learning, target } from '../fixtures/next-action'

// This evaluates deterministic personalization after classification/attribution.
// It is not a model benchmark or a claim about real users' future choices.
type Step = {
  tool: string
  event?: Partial<NextEvent>
  choice?: Partial<NextChoice>
  expected?: string | null
  edit?: (data: NextLearningData) => void
}
const block = (n: number, tool: string, patch: Partial<Step> = {}): Step[] =>
  Array.from({ length: n }, () => ({ tool, ...patch }))
const streams: Record<string, Step[]> = {
  'stable-independent': block(16, 'codex').map((s, i) => ({
    ...s,
    expected: i < 5 ? null : 'codex',
  })),
  'automatic-two-sided': block(20, 'claude', {
    choice: { attribution: 'model', confidence: 0.97 },
  }).map((s, i) => ({ ...s, expected: i < 10 ? null : 'claude' })),
  'mixed-no-stable-preference': Array.from({ length: 20 }, (_, i) => ({
    tool: i % 2 ? 'claude' : 'codex',
    expected: null,
  })),
  'recommendation-self-reinforcement': block(20, 'codex', {
    choice: { origin: 'suggestion' },
    expected: null,
  }),
  'duplicate-switches': block(20, 'codex', {
    event: { id: 'same-business-event', objectId: 'same-object' },
    expected: null,
  }),
  'new-event-type': [
    ...block(8, 'codex'),
    ...block(10, 'browser', {
      event: { eventType: 'research', action: 'research' },
    }).map((s, i) => ({ ...s, expected: i < 5 ? null : 'browser' })),
  ],
  'project-exception-and-removal': [
    ...block(8, 'codex'),
    // Transfer first; contradictory choices make the personal habit uncertain, then the local exception matures.
    ...block(8, 'claude', { event: { projectId: 'project-b' } }).map(
      (s, i) => ({ ...s, expected: i < 3 ? 'codex' : i < 5 ? null : 'claude' }),
    ),
    { tool: 'codex', expected: 'codex' },
    {
      tool: 'codex',
      event: { projectId: 'project-b' },
      expected: 'codex',
      edit: (d) => {
        const ids = new Set(
          d.events.filter((e) => e.projectId === 'project-b').map((e) => e.id),
        )
        d.events = d.events.filter((e) => !ids.has(e.id))
        d.choices = d.choices.filter((c) => !ids.has(c.eventId))
      },
    },
  ],
  'correction-and-undo': [
    ...block(5, 'codex'),
    {
      tool: 'codex',
      expected: null,
      choice: { origin: 'suggestion' },
      edit: (d) =>
        d.feedback.push({
          id: 'correction',
          choiceId: 'choice-0',
          kind: 'wrong-event',
          undone: false,
          createdAt: 100,
        }),
    },
    {
      tool: 'codex',
      expected: 'codex',
      edit: (d) => {
        d.feedback[0]!.undone = true
      },
    },
  ],
}

async function main() {
  const reports = []
  for (const [name, steps] of Object.entries(streams)) {
    const d = learning(0)
    d.grants.push({ ...d.grants[0]!, projectId: 'project-b' })
    const rows = []
    for (const [i, step] of steps.entries()) {
      step.edit?.(d)
      const e = event(`event-${i}`, { createdAt: i * 1000, ...step.event })
      // Predict before adding this event's choice. No future answer enters learning.
      const habit = learnedHabit(e, d, true)
      const candidates = ['codex', 'claude', 'browser'].map((toolId) =>
        target(`${toolId}-${e.projectId}`, { toolId, projectId: e.projectId }),
      )
      // Deliberately include a foreign project's attractive exact target: it must never leak.
      candidates.unshift(
        target('foreign-object', {
          projectId: 'never-authorized',
          toolId: habit.toolId ?? 'codex',
        }),
      )
      const ranked = rankTargets(e, d, candidates, true)
      const predicted = canRecommend(e, d, true)
        ? (ranked[0]?.toolId ?? null)
        : null
      const shifted = structuredClone(d)
      shifted.choices.forEach((c, n) => {
        c.createdAt += (n % 3) * 48 * 3600000
      })
      const invariant = learnedHabit(e, shifted, true)
      const checks = {
        expectedDecision:
          step.expected === undefined || predicted === step.expected,
        noCrossProjectObject: ranked.every(
          (t) => t.projectId === e.projectId && t.accountId === e.accountId,
        ),
        durationInvariant:
          invariant.toolId === habit.toolId && invariant.state === habit.state,
      }
      rows.push({
        index: i,
        observedPrefix: i,
        predicted,
        actual: step.tool,
        scope: habit.scope,
        checks,
      })
      const c = choice(`choice-${i}`, e.id, {
        toolId: step.tool,
        createdAt: i * 1000 + 100,
        revision: i + 1,
        ...step.choice,
      })
      if (c.attribution === 'model')
        c.evidence = [
          {
            id: `source-${i}`,
            revision: 1,
            sourceId: e.sourceId,
            grantRevision: 1,
            objectId: e.objectId,
            side: 'source',
          },
          {
            id: `dest-${i}`,
            revision: 1,
            sourceId: e.sourceId,
            grantRevision: 1,
            objectId: `destination-${i}`,
            side: 'destination',
          },
        ]
      if (!d.events.some((old) => old.id === e.id)) d.events.push(e)
      d.choices.push(c)
    }
    const offered = rows.filter((r) => r.predicted !== null)
    reports.push({
      name,
      total: rows.length,
      offered: offered.length,
      correct: offered.filter((r) => r.predicted === r.actual).length,
      precision: offered.length
        ? offered.filter((r) => r.predicted === r.actual).length /
          offered.length
        : null,
      coverage: offered.length / rows.length,
      fixedCodexCorrect: rows.filter((r) => r.actual === 'codex').length,
      checksPassed: rows.every((r) => Object.values(r.checks).every(Boolean)),
      rows,
    })
  }
  const report = {
    synthetic: true,
    scope:
      'Temporal-prefix deterministic learning replay; no live model, launch, user data or held-out human behavior.',
    predictionBeforeObservation: true,
    note: 'Eight designed behavioral streams, not independent samples of production accuracy. The fixed-Codex comparator always answers; coverage differs. Transfer errors during a new project exception are retained.',
    streams: reports,
  }
  const args = process.argv.slice(2)
  const output = resolve(
    args[args.indexOf('--output') + 1] ??
      'test-results/next-learning-replay.json',
  )
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify(
      reports.map(({ rows: _, ...summary }) => summary),
      null,
      2,
    ),
  )
  if (reports.some((r) => !r.checksPassed)) process.exitCode = 1
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

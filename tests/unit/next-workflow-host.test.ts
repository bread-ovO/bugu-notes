import { describe, it, expect, vi } from 'vitest'
import { browserObject } from '../../apps/desktop/src/main/next-action/browser-bridge'
import { ModelQueue } from '../../apps/desktop/src/main/model-queue'
import {
  parseCoreRequest,
  parseHostRequest,
  nextActionWireSchema,
  parseNextActionOutput,
} from '@memo/contracts'
import { canRecommend } from '@memo/next-action'
import { event, learning } from '../fixtures/next-action'
const token = 'a'.repeat(64)
const frame = (url = 'https://github.com/org/repo/pull/1', key = token) =>
  JSON.stringify({ token: key, payload: { type: 'visible-object', url } })
describe('browser bridge scope', () => {
  it('accepts exact paired token and https canonical object', () =>
    expect(browserObject(frame(), token)).toBe(
      'https://github.com/org/repo/pull/1',
    ))
  it.each([
    'https://github.com.evil.test/x',
    'https://evil.test/github.com',
    'http://github.com/a',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:secret@github.com/a',
    'https://github.com:444/a',
    'https://github.com@evil.test/a',
  ])('rejects %s', (url) => expect(browserObject(frame(url), token)).toBeNull())
  it.each(['b'.repeat(64), '', '💥'.repeat(64)])(
    'rejects forged token %s',
    (key) => expect(browserObject(frame(undefined, key), token)).toBeNull(),
  )
  it('rejects injected body/action and oversized frame', () => {
    expect(
      browserObject(
        JSON.stringify({
          token,
          payload: {
            type: 'visible-object',
            url: 'https://github.com/a',
            text: 'secret',
            command: 'delete',
          },
        }),
        token,
      ),
    ).toBeNull()
    expect(browserObject('x'.repeat(8193), token)).toBeNull()
    expect(browserObject('{', token)).toBeNull()
  })
})
describe('closed renderer boundary', () => {
  it.each([
    'nextActionHost.targets',
    'nextActionHost.candidates',
    'nextActionHost.visible',
    'nextActionHost.target',
    'nextActionHost.chosen',
  ])('rejects renderer use of %s', (method) =>
    expect(() => parseCoreRequest({ method })).toThrow(),
  )
  it('host accepts bounded record identity only', () => {
    expect(
      parseHostRequest({ method: 'nextActionHost.visible', recordId: 1 }),
    ).toEqual({ method: 'nextActionHost.visible', recordId: 1 })
    expect(() =>
      parseHostRequest({
        method: 'nextActionHost.visible',
        recordId: 1,
        text: 'untrusted',
      }),
    ).toThrow()
    expect(() =>
      parseHostRequest({ method: 'nextActionHost.visible', recordId: -1 }),
    ).toThrow()
  })
  it('enrollment requires explicit model consent', () => {
    expect(() =>
      parseCoreRequest({
        method: 'nextAction.enroll',
        sourceIds: ['a'],
        expectedVersion: 1,
      }),
    ).toThrow()
    expect(() =>
      parseCoreRequest({
        method: 'nextAction.enroll',
        sourceIds: ['a'],
        sendToModel: false,
        expectedVersion: 1,
      }),
    ).toThrow()
  })
})
describe('shared model queue', () => {
  it('runs fairly without overlapping provider calls', async () => {
    const queue = new ModelQueue()
    const sequence: string[] = []
    let release!: () => void
    queue.enqueue(
      'next-action',
      new AbortController().signal,
      async () => {
        sequence.push('active')
        await new Promise<void>((r) => {
          release = r
        })
      },
      vi.fn(),
    )
    for (const purpose of [
      'next-action',
      'next-action',
      'task-chat',
      undefined,
    ] as const)
      queue.enqueue(
        purpose,
        new AbortController().signal,
        async () => {
          sequence.push(purpose ?? 'extraction')
        },
        vi.fn(),
      )
    expect(sequence).toEqual(['active'])
    release()
    await vi.waitFor(() => expect(sequence).toHaveLength(5))
    expect(sequence).toEqual([
      'active',
      'task-chat',
      'extraction',
      'next-action',
      'next-action',
    ])
  })
  it('cancels queued work before provider dispatch', async () => {
    const queue = new ModelQueue()
    let release!: () => void
    queue.enqueue(
      undefined,
      new AbortController().signal,
      () =>
        new Promise((r) => {
          release = r
        }),
      vi.fn(),
    )
    const controller = new AbortController(),
      run = vi.fn(),
      cancel = vi.fn()
    queue.enqueue('next-action', controller.signal, run, cancel)
    controller.abort()
    release()
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    expect(run).not.toHaveBeenCalled()
  })
  it('bounds waiters and clears them on core exit', () => {
    const queue = new ModelQueue(),
      cancel = vi.fn()
    queue.enqueue(
      undefined,
      new AbortController().signal,
      () => new Promise(() => {}),
      vi.fn(),
    )
    for (let i = 0; i < 24; i++)
      expect(
        queue.enqueue(
          'next-action',
          new AbortController().signal,
          vi.fn(),
          cancel,
        ),
      ).toBe(true)
    expect(
      queue.enqueue(
        'next-action',
        new AbortController().signal,
        vi.fn(),
        cancel,
      ),
    ).toBe(false)
    queue.clear()
    expect(cancel).toHaveBeenCalledTimes(24)
  })
})
it('explicit preferences do not bypass independent choices or this-event rejection', () => {
  const data = learning(0)
  data.events.push(event())
  data.preferences.push({
    id: 'p',
    projectId: 'project-a',
    sourceApp: 'feishu',
    eventType: 'bug_fix',
    action: 'handle',
    toolId: 'codex',
  })
  expect(canRecommend(event(), data, true)).toBe(false)
  expect(data.choices).toHaveLength(0)
  data.choices.push({
    id: 'choice',
    eventId: 'e1',
    eventRevision: 1,
    revision: 1,
    toolId: 'codex',
    origin: 'suggestion',
    attribution: 'unknown',
    confidence: 0,
    createdAt: 1000,
    evidence: [],
  })
  data.feedback.push({
    id: 'feedback',
    choiceId: 'choice',
    kind: 'wrong-event',
    undone: false,
    createdAt: 1000,
  })
  expect(canRecommend(event(), data, true)).toBe(false)
})

it('uses provider-compatible wire schema but retains strict duplicate rejection locally', () => {
  expect(nextActionWireSchema.properties.targetIds).not.toHaveProperty(
    'uniqueItems',
  )
  expect(() =>
    parseNextActionOutput(
      JSON.stringify({
        mode: 'recommend',
        eventType: 'bug_fix',
        action: 'handle',
        related: true,
        confidence: 1,
        targetIds: ['a', 'a'],
        citations: [],
        reason: 'fixture',
      }),
    ),
  ).toThrow()
})

import {
  nextActionCorpus,
  nextActionEvaluationOrder,
} from '../fixtures/next-action-corpus'
import { executableTool } from '../../apps/desktop/src/main/next-action/app-catalog'

describe('evaluation sample coverage', () => {
  it('preserves all cases and covers all types and negative attribution in the smoke subset', () => {
    const ordered = nextActionEvaluationOrder()
    expect(new Set(ordered.map((c) => c.id))).toEqual(
      new Set(nextActionCorpus.map((c) => c.id)),
    )
    expect(ordered).toHaveLength(360)
    const smoke = ordered.slice(0, 24)
    expect(new Set(smoke.map((c) => c.family)).size).toBe(24)
    expect(
      new Set(
        smoke
          .filter((c) => c.input.mode === 'classify-event')
          .map((c) => c.expected.type),
      ).size,
    ).toBe(8)
    expect(
      smoke.some(
        (c) => c.input.mode === 'attribute-transition' && !c.expected.related,
      ),
    ).toBe(true)
  })
})

describe('custom application identities', () => {
  it('keeps labels readable while encoding spaces and long names in a bounded target id', () => {
    const app = executableTool(`/apps/${'My Editor '.repeat(20)}.exe`, 'win32')
    expect(app.id).not.toMatch(/\s/)
    expect(app.label.length).toBeLessThanOrEqual(120)
    expect(
      parseHostRequest({
        method: 'nextActionHost.targets',
        targets: [{ id: app.id, label: app.label }],
      }),
    ).toBeTruthy()
  })
  it('uses the same known tool id whether discovered automatically or selected manually', () => {
    expect(executableTool('/apps/Code.exe', 'win32').id).toBe('vscode')
    expect(executableTool('/apps/codex', 'linux').id).toBe('codex')
    expect(executableTool('/apps/My Editor.exe', 'win32').id).toBe(
      executableTool('/elsewhere/my editor.EXE', 'win32').id,
    )
  })
})

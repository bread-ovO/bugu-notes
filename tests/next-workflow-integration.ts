import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '@memo/storage'
import {
  defaultNextActionSettings,
  parseCoreRequest,
  parseHostRequest,
  type NextModelInput,
  type NextActionOutput,
} from '@memo/contracts'
import { createNextActionService } from '../apps/desktop/src/core/next-action-service'
import { createNextWorkflow } from '../apps/desktop/src/core/next-workflow'
async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'bugu-workflow-'))
  const path = join(dir, 'store.sqlite')
  let store = openStore(path)
  try {
    store.tasks.createProject('p', '虚构工作区')
    store.tasks.createProject('other', '隔离工作区')
    const file = join(dir, 'session.jsonl')
    writeFileSync(file, '')
    const source = store.sources.authorize({
      path: file,
      projectId: 'p',
      displayName: 'Codex 会话 · 虚构测试',
    })
    const events = Array.from({ length: 7 }, (_, i) => ({
      schemaVersion: 1 as const,
      sourceInstanceId: source.id,
      externalId: `record-${i}`,
      revision: '1',
      occurredAt: new Date().toISOString(),
      role: 'user' as const,
      text: `BUG-${i} 登录页在刷新后出现白屏。请定位回调处理错误，完成修复后跑回归测试并反馈修改记录。这是隔离测试数据。`,
    }))
    store.sources.receiveBatch(
      source.id,
      source.grantVersion,
      events,
      'done',
      '',
    )
    const v = () => store.nextAction.snapshot().version
    let calls = 0
    const model = async (request: import('@memo/model').TaskModelRequest) => {
      calls++
      const input = JSON.parse(request.messages[1]!.content) as NextModelInput
      const output: NextActionOutput = {
        mode: input.mode,
        eventType:
          input.mode === 'classify-event' ? 'bug_fix' : input.event.eventType,
        action: 'handle',
        related: true,
        confidence: 0.99,
        citations: input.evidence.map((e) => ({
          id: e.id,
          revision: e.revision,
          quote: e.text.slice(0, 20),
        })),
        targetIds: input.mode === 'recommend' ? [input.targets[0]!.id] : [],
        reason: '测试引用与事件一致',
      }
      return { model: 'isolated-test', content: JSON.stringify(output) }
    }
    const service = createNextActionService(store, model)
    const workflow = createNextWorkflow(store, service)
    const idle = async () => {
      for (let i = 0; i < 100 && workflow.snapshot().busy; i++)
        await new Promise((r) => setTimeout(r, 5))
      assert.equal(workflow.snapshot().busy, false)
      assert.equal(workflow.snapshot().error, null)
    }
    assert.equal(workflow.snapshot().sources.length, 1)
    assert.equal(workflow.snapshot().contexts.length, 0)
    assert.equal(calls, 0, 'sync never implies seen')
    assert.throws(
      () =>
        workflow.handle({
          method: 'nextAction.enroll',
          sourceIds: ['foreign'],
          sendToModel: true,
          expectedVersion: v(),
        }),
      /NEXT_NOT_AUTHORIZED/,
    )
    workflow.handle({
      method: 'nextAction.enroll',
      sourceIds: [source.id],
      sendToModel: true,
      expectedVersion: v(),
    })
    store.nextAction.configure(
      { ...defaultNextActionSettings, enabled: true },
      v(),
    )
    workflow.handle({
      method: 'nextActionHost.targets',
      targets: [
        { id: 'codex', label: 'Codex' },
        { id: 'vscode', label: 'Code' },
      ],
    })
    const contexts = workflow.snapshot().contexts
    assert.equal(contexts.length, 7)
    assert.throws(
      () => workflow.handle({ method: 'nextAction.inspect', recordId: 9999 }),
      /NOT_FOUND/,
    )
    assert.equal(
      store.nextWorkflow.visibleCandidates().length,
      0,
      'observation separately opt-in',
    )
    workflow.handle({
      method: 'nextAction.observation',
      enabled: true,
      appIds: ['codex'],
    })
    assert.equal(store.nextWorkflow.visibleCandidates().length, 7)
    for (const context of contexts.slice(0, 5)) {
      workflow.handle({
        method: 'nextAction.inspect',
        recordId: context.recordId,
      })
      await idle()
      const event = workflow
        .snapshot()
        .events.find((e) => e.recordId === context.recordId)!
      workflow.handle({
        method: 'nextActionHost.chosen',
        eventId: event.id,
        targetId: 'app:codex',
        origin: 'explicit',
        result: 'dispatched',
      })
    }
    assert.equal(store.nextAction.snapshot().choiceCount, 5)
    const fresh = contexts[5]!
    workflow.handle({ method: 'nextAction.inspect', recordId: fresh.recordId })
    await idle()
    const recommendation = workflow.snapshot().suggestions[0]!
    assert.ok(recommendation)
    assert.equal(recommendation.targetId, 'app:codex')
    assert.equal(
      workflow.snapshot().events.find((e) => e.recordId === fresh.recordId)!
        .habit.state,
      'ready',
    )
    const before = calls
    workflow.handle({ method: 'nextAction.inspect', recordId: fresh.recordId })
    await idle()
    assert.equal(
      calls,
      before + 1,
      'classification cached; recommendation can refresh',
    )
    assert.equal(
      workflow.snapshot().suggestions.length,
      1,
      'deduplicate pending offer',
    )
    workflow.handle({
      method: 'nextActionHost.chosen',
      eventId: recommendation.eventId,
      targetId: recommendation.targetId,
      suggestionId: recommendation.id,
      origin: 'suggestion',
      result: 'dispatched',
    })
    assert.equal(
      store.nextAction.snapshot().choiceCount,
      5,
      'recommendation does not train itself',
    )
    assert.throws(
      () =>
        workflow.handle({
          method: 'nextActionHost.chosen',
          eventId: recommendation.eventId,
          targetId: recommendation.targetId,
          suggestionId: recommendation.id,
          origin: 'suggestion',
          result: 'dispatched',
        }),
      /NEXT_INVALID_TARGET/,
    )
    const event = workflow
      .snapshot()
      .events.find((e) => e.recordId === contexts[0]!.recordId)!
    const choice = store.nextAction
      .data()
      .choices.find((c) => c.eventId === event.id)!
    const feedback = store.nextAction
      .feedback(choice.id, 'wrong-event', v())
      .recent.find((c) => c.choiceId === choice.id)!.feedback!
    assert.equal(store.nextAction.snapshot().choiceCount, 4)
    store.nextAction.undo(feedback.id, v())
    assert.equal(store.nextAction.snapshot().choiceCount, 5)
    workflow.handle({
      method: 'nextAction.prefer',
      eventId: event.id,
      toolId: 'vscode',
      scope: 'project',
    })
    assert.equal(store.nextAction.data().preferences[0]!.toolId, 'vscode')
    workflow.handle({
      method: 'nextAction.reclassify',
      eventId: event.id,
      eventType: 'research',
    })
    await idle()
    assert.equal(
      store.nextAction.data().events.find((e) => e.id === event.id)!.eventType,
      'research',
    )
    assert.throws(() =>
      parseCoreRequest({
        method: 'nextActionHost.chosen',
        eventId: event.id,
        targetId: 'app:codex',
        origin: 'explicit',
        result: 'dispatched',
      }),
    )
    assert.equal(
      parseHostRequest({ method: 'nextActionHost.candidates' }).method,
      'nextActionHost.candidates',
    )
    assert.throws(() =>
      parseCoreRequest({
        method: 'nextAction.inspect',
        recordId: 1,
        url: 'https://evil.test',
      }),
    )
    service.dispose()
    store.close()
    store = openStore(path)
    assert.equal(store.nextWorkflow.sources()[0]!.selected, true)
    assert.equal(store.nextWorkflow.observation().enabled, true)
    assert.equal(
      store.nextWorkflow.suggestions().some((s) => s.state === 'confirmed'),
      true,
    )
    store.sources.revoke(source.id)
    store.nextWorkflow.reconcile()
    assert.equal(store.nextAction.snapshot().eventCount, 0)
    assert.equal(store.nextWorkflow.contexts().length, 0)
    assert.equal(store.nextWorkflow.suggestions().length, 0)
    for (let i = calls; i < 100; i++) store.nextWorkflow.takeBudget()
    assert.throws(
      () => store.nextWorkflow.takeBudget(),
      /NEXT_BUDGET_EXHAUSTED/,
    )
    store.close()
    store = openStore(path)
    assert.throws(
      () => store.nextWorkflow.takeBudget(),
      /NEXT_BUDGET_EXHAUSTED/,
    )
    console.log(
      'next-workflow integration passed: source grants, real pipeline contract, learning, recommendations, corrections, restart, revocation, persistent budget',
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
void main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})

import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createNextActionStore } from '../packages/storage/src/next-action'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '@memo/storage'
import { canRecommend } from '@memo/next-action'
import { defaultNextActionSettings } from '@memo/contracts'
import { createNextActionService } from '../apps/desktop/src/core/next-action-service'
import { event, choice, modelInput, output, target } from './fixtures/next-action'

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'bugu-next-action-integration-'))
  const path = join(root, 'store.sqlite')
  let store = openStore(path)
  try {
    assert.equal(store.health().schemaVersion, 27)
    store.tasks.createProject('project-a', '虚构测试项目')
    store.tasks.createProject('project-b', '隔离测试项目')
    const grant = { projectId: 'project-a', accountId: 'account-a', sourceId: 'source-a', revision: 1, active: true }
    store.nextAction.grant(grant)
    store.nextAction.grant({ ...grant, sourceId: 'source-b' })
    const version = () => store.nextAction.snapshot().version
    const time = Date.now() - 5000
    const testEvent = (id: string) => event(id, { createdAt: time })
    assert.throws(() => store.nextAction.putEvent(testEvent('disabled'), version()), /NEXT_NOT_AUTHORIZED/)
    store.nextAction.configure({ ...defaultNextActionSettings, enabled: true }, version())
    assert.throws(() => store.nextAction.configure(defaultNextActionSettings, 1), /VERSION_CONFLICT/)
    for (let n = 0; n < 5; n++) {
      store.nextAction.putEvent(testEvent(`e${n}`), version())
      store.nextAction.putChoice(choice(`c${n}`, `e${n}`, { createdAt: time + 1000 }), version())
    }
    assert.equal(canRecommend(testEvent('fresh'), store.nextAction.data(), true), true)
    assert.throws(() => store.nextAction.putEvent({ ...testEvent('duplicate'), objectId: 'message-e0' }, version()), /VERSION_CONFLICT/)
    assert.throws(() => store.nextAction.putChoice(choice('again', 'e0', { createdAt: time + 1000 }), version()), /VERSION_CONFLICT/)
    assert.equal(store.nextAction.snapshot().eventCount, 5)
    const feedback = store.nextAction.feedback('c0', 'wrong-event', version()).recent.find(c => c.choiceId === 'c0')!.feedback!
    assert.equal(canRecommend(testEvent('fresh'), store.nextAction.data(), true), false)
    store.nextAction.undo(feedback.id, version())
    assert.equal(canRecommend(testEvent('fresh'), store.nextAction.data(), true), true)
    for (const kind of ['wrong-target', 'launch-failed', 'dismissed'] as const) {
      store.nextAction.feedback('c0', kind, version())
      assert.equal(canRecommend(testEvent('fresh'), store.nextAction.data(), true), true)
    }
    store.close(); store = openStore(path)
    assert.equal(store.nextAction.snapshot().eventCount, 5)
    assert.equal(canRecommend(testEvent('fresh'), store.nextAction.data(), true), true)
    let calls = 0
    const service = createNextActionService(store, async request => {
      calls++
      assert.equal(request.purpose, 'next-action')
      const input = JSON.parse(request.messages[1]!.content)
      return { content: JSON.stringify(output({ mode: input.mode, targetIds: input.mode === 'recommend' ? ['codex-a'] : [] })), model: 'isolated-fixture' }
    })
    const evidence = modelInput().evidence
    assert.deepEqual((await service.recommend('e1', evidence, [target()])).map(t => t.id), ['codex-a'])
    assert.equal(calls, 1)
    store.nextAction.feedback('c0', 'wrong-event', version())
    assert.deepEqual(await service.recommend('e1', evidence, [target()]), [])
    assert.equal(calls, 1, 'cold start must not call the recommendation model')
    store.nextAction.undo(store.nextAction.snapshot().recent.find(c => c.choiceId === 'c0')!.feedback!.id, version())
    const forEvent = (id: string) => evidence.map(e => e.side === 'source' ? { ...e, objectId: `message-${id}` } : e)
    await service.observe(testEvent('observed'), forEvent('observed'))
    await service.attribute({ eventId: 'observed', choiceId: 'auto-link', revision: 1, target: target(), evidence: forEvent('observed') })
    assert.equal(store.nextAction.data().choices.find(c => c.id === 'auto-link')!.attribution, 'model')
    assert.equal(store.nextAction.data().choices.find(c => c.id === 'auto-link')!.origin, 'natural')
    store.nextAction.revoke('project-a', 'account-a', 'source-b')
    assert.equal(store.nextAction.data().choices.some(c => c.id === 'auto-link'), false, 'destination withdrawal removes its dependent contribution')
    const callsBeforeRevokedEvidence = calls
    await assert.rejects(service.attribute({ eventId: 'observed', choiceId: 'relink', revision: 2, target: target(), evidence: forEvent('observed') }), /NEXT_NOT_AUTHORIZED/)
    assert.equal(calls, callsBeforeRevokedEvidence)
    store.nextAction.grant({ ...grant, sourceId: 'source-b', revision: 3 })
    evidence[1]!.grantRevision = 3
    const beforeUnauthorized = calls
    await assert.rejects(service.observe(event('foreign', { projectId: 'project-b', createdAt: time }), evidence), /NEXT_NOT_AUTHORIZED/)
    assert.equal(calls, beforeUnauthorized, 'unauthorized text must not leave core')
    service.dispose()
    let complete!: (result: { content: string; model: string }) => void
    const lateService = createNextActionService(store, () => new Promise(resolve => { complete = resolve }))
    const pending = lateService.observe(testEvent('late'), forEvent('late'))
    store.nextAction.revoke('project-a', 'account-a', 'source-a')
    complete({ content: JSON.stringify(output({ mode: 'classify-event' })), model: 'isolated-fixture' })
    await assert.rejects(pending, /NEXT_STALE_RESULT/)
    assert.equal(store.nextAction.snapshot().eventCount, 0)
    assert.equal(store.nextAction.snapshot().choiceCount, 0)
    assert.equal(store.nextAction.data().feedback.length, 0)
    assert.throws(() => store.nextAction.grant(grant), /VERSION_CONFLICT/)
    assert.throws(() => store.nextAction.putEvent(testEvent('resurrect'), version()), /NEXT_NOT_AUTHORIZED/)
    lateService.dispose()
    store.nextAction.grant({ ...grant, revision: 3 })
    assert.equal(canRecommend({ ...testEvent('new'), grantRevision: 3 }, store.nextAction.data(), true), false)
    store.nextAction.clear(version())
    assert.deepEqual(store.nextAction.snapshot().settings, defaultNextActionSettings)
    assert.equal(store.nextAction.data().grants.length, 0)
    assert.equal(store.tasks.list('project-a').length, 0)
    // Recreate the v25 boundary while preserving existing workspace tables.
    store.close()
    const oldDb = new Database(path)
    oldDb.exec('DROP TABLE next_action_scopes; DROP TABLE next_action_suggestions; DROP TABLE next_action_observation; DROP TABLE next_action_budget; DROP TABLE next_action_feedback; DROP TABLE next_action_choices; DROP TABLE next_action_events; DROP TABLE next_action_grants; DROP TABLE next_action_preferences; DROP TABLE next_action_state; PRAGMA user_version=25;')
    oldDb.close()
    store = openStore(path)
    assert.equal(store.health().schemaVersion, 27)
    store.nextAction.grant(grant) // Existing project survived migration.
    store.nextAction.configure({ ...defaultNextActionSettings, enabled: true }, store.nextAction.snapshot().version)
    store.nextAction.putEvent(testEvent('retained'), store.nextAction.snapshot().version)
    store.nextAction.putChoice(choice('retained-choice', 'retained', { createdAt: time + 1000 }), store.nextAction.snapshot().version)
    store.close()
    const retentionDb = new Database(path)
    retentionDb.pragma('foreign_keys = ON')
    const futureRepo = createNextActionStore(retentionDb, () => Date.now() + 31 * 86400000)
    futureRepo.prune()
    assert.equal(futureRepo.snapshot().eventCount, 0)
    assert.equal(futureRepo.data().choices.length, 0)
    retentionDb.close()
    store = openStore(path)
    console.log('Next-action integration: persistence, version fences, model routing, cold start, correction, revoke, late-result and reset passed')
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })

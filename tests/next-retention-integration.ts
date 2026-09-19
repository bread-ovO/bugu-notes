import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '@memo/storage'
import { createNextWorkflowStore } from '../packages/storage/src/next-workflow'
import { createNextActionStore } from '../packages/storage/src/next-action'
import { canRecommend, learnedHabit } from '@memo/next-action'
import { defaultNextActionSettings } from '@memo/contracts'
import { event, choice } from './fixtures/next-action'
const DAY = 86400000
const directory = mkdtempSync(join(tmpdir(), 'bugu-retention-'))
const path = join(directory, 'fixture.sqlite')
try {
  const initial = openStore(path)
  initial.tasks.createProject('project-a', '合成测试')
  initial.close()
  const db = new Database(path)
  db.pragma('foreign_keys=ON')
  let now = 100 * DAY
  const store = createNextActionStore(db, () => now)
  const version = () => store.snapshot().version
  const grant = {
    projectId: 'project-a',
    accountId: 'account-a',
    sourceId: 'source-a',
    revision: 1,
    active: true,
  }
  store.grant(grant)
  store.configure({ ...defaultNextActionSettings, enabled: true }, version())
  for (let i = 0; i < 6; i++) {
    store.putEvent(event(`e${i}`, { createdAt: now }), version())
    store.putChoice(choice(`c${i}`, `e${i}`, { createdAt: now }), version())
  }
  store.feedback('c5', 'wrong-event', version())
  now += 31 * DAY
  store.prune()
  assert.equal(
    store.data().events.length,
    0,
    'recent records expire after 30 days',
  )
  assert.equal(store.data().choices.length, 0)
  assert.equal(store.data().feedback.length, 0)
  assert.equal(
    store.data().contributions?.length,
    5,
    'retracted choices must not be archived',
  )
  assert.equal(
    canRecommend(event('new', { createdAt: now }), store.data(), true),
    true,
    '90-day contribution survives recent-record expiry',
  )
  const payload = JSON.stringify(store.data().contributions)
  assert.ok(
    !/"(text|quote|title|url|reason)":/.test(payload),
    'no content copied into contribution layer',
  )
  const restarted = createNextActionStore(db, () => now)
  assert.equal(
    canRecommend(event('new', { createdAt: now }), restarted.data(), true),
    true,
  )
  // Revisiting the same event cannot count its archived and live form twice.
  store.putEvent(event('e0', { createdAt: now, revision: 2 }), version())
  assert.equal(store.data().contributions?.length, 4)
  assert.equal(learnedHabit(event('new'), store.data(), true).eventCount, 4)
  store.putChoice(
    choice('new-c0', 'e0', { createdAt: now, eventRevision: 2 }),
    version(),
  )
  assert.equal(learnedHabit(event('new'), store.data(), true).eventCount, 5)
  store.configure(
    { ...store.state().settings, contributionDays: 30 },
    version(),
  )
  assert.equal(store.data().contributions?.length, 0, 'shortening is immediate')
  store.configure(
    { ...store.state().settings, contributionDays: 90 },
    version(),
  )
  assert.equal(
    store.data().contributions?.length,
    0,
    'extending does not resurrect deleted history',
  )
  now += 31 * DAY
  store.prune()
  assert.equal(store.data().contributions?.length, 1)
  store.revoke(grant.projectId, grant.accountId, grant.sourceId)
  assert.equal(
    store.data().contributions?.length,
    0,
    'revocation removes retained contribution',
  )
  store.grant({ ...grant, revision: 3 })
  store.putEvent(
    event('expiry', { createdAt: now, grantRevision: 3 }),
    version(),
  )
  store.putChoice(
    choice('expiry-choice', 'expiry', { createdAt: now }),
    version(),
  )
  now += 31 * DAY
  store.prune()
  assert.equal(store.data().contributions?.length, 1)
  now += 60 * DAY
  store.prune()
  assert.equal(store.data().contributions?.length, 0, '90-day hard limit')
  store.configure(
    { ...store.state().settings, historyDays: 7, contributionDays: 0 },
    version(),
  )
  store.putEvent(
    event('noarchive', { createdAt: now, grantRevision: 3 }),
    version(),
  )
  store.putChoice(
    choice('noarchive-choice', 'noarchive', { createdAt: now }),
    version(),
  )
  now += 8 * DAY
  store.prune()
  assert.equal(store.data().events.length, 0)
  assert.equal(store.data().contributions?.length, 0)
  store.configure(
    { ...store.state().settings, contributionDays: 90 },
    version(),
  )
  store.grant({ ...grant, sourceId: 'source-b' })
  store.putEvent(
    event('linked', { createdAt: now, grantRevision: 3 }),
    version(),
  )
  store.putChoice(
    choice('linked-choice', 'linked', {
      createdAt: now,
      attribution: 'model',
      confidence: 0.99,
      evidence: [
        {
          id: 'source',
          revision: 1,
          sourceId: 'source-a',
          grantRevision: 3,
          objectId: 'message-linked',
          side: 'source',
        },
        {
          id: 'destination',
          revision: 1,
          sourceId: 'source-b',
          grantRevision: 1,
          objectId: 'destination',
          side: 'destination',
        },
      ],
    }),
    version(),
  )
  now += 8 * DAY
  store.prune()
  assert.equal(store.data().contributions?.length, 1)
  store.revoke(grant.projectId, grant.accountId, 'source-b')
  assert.equal(
    store.data().contributions?.length,
    0,
    'destination revocation invalidates retained natural attribution',
  )
  for (const id of ['tool-clear', 'project-clear']) {
    store.putEvent(event(id, { createdAt: now, grantRevision: 3 }), version())
    store.putChoice(choice(id + '-choice', id, { createdAt: now }), version())
    now += 8 * DAY
    store.prune()
    assert.equal(store.data().contributions?.length, 1)
    const workflow = createNextWorkflowStore(db, () => now)
    workflow.erase(
      id === 'tool-clear' ? 'tool' : 'project',
      id === 'tool-clear' ? 'codex' : 'project-a',
    )
    assert.equal(
      store.data().contributions?.length,
      0,
      'scoped deletion clears retained facts',
    )
  }
  store.clear(version())
  assert.equal(
    (
      db.prepare('SELECT count(*) n FROM next_action_contributions').get() as {
        n: number
      }
    ).n,
    0,
  )
  db.close()
  console.log(
    'next-retention integration passed: 30/90-day separation, deduplication, correction, restart, expiry, shortening, revocation, opt-out',
  )
} finally {
  rmSync(directory, { recursive: true, force: true })
}

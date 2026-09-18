import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import {
  defaultNextActionSettings, parseNextChoice, parseNextEvent, parseNextSettings,
  type NextActionSettings, type NextActionSnapshot, type NextChoice, type NextEvent,
  type NextFeedback, type NextFeedbackKind, type NextGrant, type NextLearningData, type NextPreference,
} from '@memo/contracts'
import { choiceContribution, latestIndependentChoices, hasEventGrant, normalizeConfirmShortcut } from '@memo/next-action'

const DAY = 86400000
export function migrateNextAction(db: Database.Database): void {
  db.transaction(() => { db.exec(`
    CREATE TABLE next_action_state(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, settings TEXT NOT NULL);
    CREATE TABLE next_action_grants(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL, source_id TEXT NOT NULL, revision INTEGER NOT NULL, active INTEGER NOT NULL,
      PRIMARY KEY(project_id,account_id,source_id));
    CREATE TABLE next_action_events(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL, source_id TEXT NOT NULL, object_id TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL,
      UNIQUE(project_id,account_id,source_id,object_id));
    CREATE TABLE next_action_choices(id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES next_action_events(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(event_id,revision));
    CREATE TABLE next_action_feedback(id TEXT PRIMARY KEY, choice_id TEXT NOT NULL REFERENCES next_action_choices(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE next_action_preferences(id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, payload TEXT NOT NULL);
    CREATE INDEX next_action_choices_created ON next_action_choices(created_at);
    CREATE INDEX next_action_events_created ON next_action_events(created_at);
    PRAGMA user_version=26;
  `)
  db.prepare('INSERT OR IGNORE INTO next_action_state VALUES(1,1,?)').run(JSON.stringify(defaultNextActionSettings))
  })()
}

/** Trusted core only. No observation/grant/target write methods are exposed to renderer IPC. */
export function createNextActionStore(db: Database.Database, now = Date.now) {
  const readState = (): { version: number; settings: NextActionSettings } => {
    const row = db.prepare('SELECT version,settings FROM next_action_state WHERE id=1').get() as { version: number; settings: string }
    return { version: row.version, settings: parseNextSettings(JSON.parse(row.settings)) }
  }
  const bump = () => db.prepare('UPDATE next_action_state SET version=version+1 WHERE id=1').run()
  const expectVersion = (version: number) => {
    if (version !== readState().version) throw Error('VERSION_CONFLICT')
  }
  const all = <T>(table: string): T[] => (db.prepare(`SELECT payload FROM ${table}`).all() as { payload: string }[]).map(r => JSON.parse(r.payload) as T)
  const data = (): NextLearningData => ({
    events: all<NextEvent>('next_action_events'), choices: all<NextChoice>('next_action_choices'),
    feedback: all<NextFeedback>('next_action_feedback'), preferences: all<NextPreference>('next_action_preferences'),
    grants: (db.prepare('SELECT * FROM next_action_grants').all() as { project_id: string; account_id: string; source_id: string; revision: number; active: number }[])
      .map(g => ({ projectId: g.project_id, accountId: g.account_id, sourceId: g.source_id, revision: g.revision, active: !!g.active })),
  })
  const snapshot = (): NextActionSnapshot => {
    const d = data()
    const validEvents = new Map(d.events.filter(e => hasEventGrant(e, d)).map(e => [e.id, e]))
    const choices = d.choices.filter(c => validEvents.get(c.eventId)?.revision === c.eventRevision)
    return { ...readState(), eventCount: validEvents.size, choiceCount: [...latestIndependentChoices(d).values()].filter(c => validEvents.has(c.eventId) && choiceContribution(c, validEvents.get(c.eventId)!, d) > 0).length,
      recent: choices.filter(c => c.createdAt >= now() - 30 * DAY).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20)
        .map(c => ({ choiceId: c.id, toolId: c.toolId, eventType: validEvents.get(c.eventId)!.eventType, createdAt: c.createdAt,
          feedback: [...d.feedback].reverse().find(f => f.choiceId === c.id && !f.undone) ?? null })),
    }
  }
  const removeSourceChoices = (projectId: string, accountId: string, sourceId: string) => {
    const d = data()
    const scoped = new Set(d.events.filter(e => e.projectId === projectId && e.accountId === accountId).map(e => e.id))
    for (const c of d.choices) if (scoped.has(c.eventId) && c.evidence.some(e => e.sourceId === sourceId))
      db.prepare('DELETE FROM next_action_choices WHERE id=?').run(c.id)
  }
  const prune = db.transaction(() => {
    const result = db.prepare('DELETE FROM next_action_events WHERE created_at<? OR id IN (SELECT id FROM next_action_events ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 5000)').run(now() - 30 * DAY)
    const choices = db.prepare('DELETE FROM next_action_choices WHERE id IN (SELECT id FROM next_action_choices ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 20000)').run()
    const feedback = db.prepare('DELETE FROM next_action_feedback WHERE id IN (SELECT id FROM next_action_feedback ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 20000)').run()
    if (result.changes || choices.changes || feedback.changes) bump()
  })
  return {
    data, snapshot, prune,
    configure(settings: NextActionSettings, expectedVersion: number): NextActionSnapshot {
      return db.transaction(() => {
        expectVersion(expectedVersion)
        const parsed = parseNextSettings(settings)
        normalizeConfirmShortcut(parsed.shortcut)
        db.prepare('UPDATE next_action_state SET version=version+1,settings=? WHERE id=1').run(JSON.stringify(parsed))
        return snapshot()
      })()
    },
    clear(expectedVersion: number): NextActionSnapshot {
      return db.transaction(() => {
        expectVersion(expectedVersion)
        db.exec('DELETE FROM next_action_events; DELETE FROM next_action_preferences; DELETE FROM next_action_grants;')
        db.prepare('UPDATE next_action_state SET version=version+1,settings=? WHERE id=1').run(JSON.stringify(defaultNextActionSettings))
        return snapshot()
      })()
    },
    grant(grant: NextGrant): void {
      db.transaction(() => {
        if (!grant.active || ![grant.projectId, grant.accountId, grant.sourceId].every(v => v && v.length <= 256) ||
            !Number.isSafeInteger(grant.revision) || grant.revision < 1) throw Error('NEXT_INVALID_GRANT')
        const old = db.prepare('SELECT revision FROM next_action_grants WHERE project_id=? AND account_id=? AND source_id=?')
          .get(grant.projectId, grant.accountId, grant.sourceId) as { revision: number } | undefined
        if (old && grant.revision <= old.revision) throw Error('VERSION_CONFLICT')
        removeSourceChoices(grant.projectId, grant.accountId, grant.sourceId)
        db.prepare('DELETE FROM next_action_events WHERE project_id=? AND account_id=? AND source_id=?').run(grant.projectId, grant.accountId, grant.sourceId)
        db.prepare('INSERT OR REPLACE INTO next_action_grants VALUES(?,?,?,?,1)').run(grant.projectId, grant.accountId, grant.sourceId, grant.revision)
        bump()
      })()
    },
    revoke(projectId: string, accountId: string, sourceId: string): void {
      db.transaction(() => {
        removeSourceChoices(projectId, accountId, sourceId)
        // Keep a revision tombstone so delayed observations cannot revive a withdrawn grant.
        db.prepare('UPDATE next_action_grants SET revision=revision+1,active=0 WHERE project_id=? AND account_id=? AND source_id=?').run(projectId, accountId, sourceId)
        db.prepare('DELETE FROM next_action_events WHERE project_id=? AND account_id=? AND source_id=?').run(projectId, accountId, sourceId)
        bump()
      })()
    },
    putEvent(value: NextEvent, expectedVersion: number): void {
      db.transaction(() => {
        expectVersion(expectedVersion)
        const event = parseNextEvent(value)
        if (!readState().settings.enabled || !hasEventGrant(event, data()) || event.createdAt > now() || event.createdAt < now() - 30 * DAY)
          throw Error('NEXT_NOT_AUTHORIZED')
        const old = db.prepare('SELECT payload FROM next_action_events WHERE id=? OR (project_id=? AND account_id=? AND source_id=? AND object_id=?)')
          .get(event.id, event.projectId, event.accountId, event.sourceId, event.objectId) as { payload: string } | undefined
        if (old) {
          const previous = parseNextEvent(JSON.parse(old.payload))
          if (previous.id !== event.id || previous.projectId !== event.projectId || previous.accountId !== event.accountId ||
              previous.sourceId !== event.sourceId || previous.objectId !== event.objectId || previous.revision >= event.revision)
            throw Error('VERSION_CONFLICT')
        }
        db.prepare(`INSERT INTO next_action_events VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`)
          .run(event.id, event.projectId, event.accountId, event.sourceId, event.objectId, event.createdAt, JSON.stringify(event))
        bump()
        prune()
      })()
    },
    putChoice(value: NextChoice, expectedVersion: number): void {
      db.transaction(() => {
        expectVersion(expectedVersion)
        const c = parseNextChoice(value)
        const d = data()
        const e = d.events.find(e => e.id === c.eventId && e.revision === c.eventRevision)
        if (!readState().settings.enabled || !e || !hasEventGrant(e, d) || c.createdAt > now() || c.createdAt < e.createdAt)
          throw Error('NEXT_NOT_AUTHORIZED')
        if (c.evidence.some(ref => !d.grants.some(g => g.active && g.projectId === e.projectId && g.accountId === e.accountId &&
            g.sourceId === ref.sourceId && g.revision === ref.grantRevision))) throw Error('NEXT_NOT_AUTHORIZED')
        const latest = d.choices.filter(x => x.eventId === c.eventId).reduce((max, x) => Math.max(max, x.revision), 0)
        if (c.revision <= latest) throw Error('VERSION_CONFLICT')
        db.prepare('INSERT INTO next_action_choices VALUES(?,?,?,?,?)').run(c.id, c.eventId, c.revision, c.createdAt, JSON.stringify(c))
        bump()
        prune()
      })()
    },
    feedback(choiceId: string, kind: NextFeedbackKind, expectedVersion: number): NextActionSnapshot {
      return db.transaction(() => {
        expectVersion(expectedVersion)
        if (!['wrong-event', 'wrong-type', 'wrong-target', 'launch-failed', 'dismissed'].includes(kind)) throw Error('INVALID_REQUEST')
        if (!db.prepare('SELECT 1 FROM next_action_choices WHERE id=?').get(choiceId)) throw Error('NOT_FOUND')
        const feedback: NextFeedback = { id: randomUUID(), choiceId, kind, undone: false, createdAt: now() }
        db.prepare('INSERT INTO next_action_feedback VALUES(?,?,?,?)').run(feedback.id, choiceId, feedback.createdAt, JSON.stringify(feedback))
        bump()
        prune()
        return snapshot()
      })()
    },
    undo(feedbackId: string, expectedVersion: number): NextActionSnapshot {
      return db.transaction(() => {
        expectVersion(expectedVersion)
        const row = db.prepare('SELECT payload FROM next_action_feedback WHERE id=?').get(feedbackId) as { payload: string } | undefined
        if (!row) throw Error('NOT_FOUND')
        const feedback = JSON.parse(row.payload) as NextFeedback
        if (feedback.undone) throw Error('VERSION_CONFLICT')
        feedback.undone = true
        db.prepare('UPDATE next_action_feedback SET payload=? WHERE id=?').run(JSON.stringify(feedback), feedbackId)
        bump()
        return snapshot()
      })()
    },
  }
}

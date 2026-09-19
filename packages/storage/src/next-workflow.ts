import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import type {
  NextContextOption,
  NextEvent,
  NextEvidence,
  NextSourceOption,
  NextSuggestion,
  NextTarget,
  NextPreference,
  NextEventType,
} from '@memo/contracts'
import { createNextActionStore } from './next-action'
export function migrateNextWorkflow(db: Database.Database) {
  db.transaction(() =>
    db.exec(`
    CREATE TABLE next_action_scopes(source_id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,base_version INTEGER NOT NULL);
    CREATE TABLE next_action_suggestions(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES next_action_events(id) ON DELETE CASCADE,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE next_action_observation(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL,apps TEXT NOT NULL);
    INSERT INTO next_action_observation VALUES(1,0,'[]');
    CREATE TABLE next_action_budget(day TEXT PRIMARY KEY,calls INTEGER NOT NULL);
    PRAGMA user_version=27;
  `),
  )()
}
interface Source extends NextSourceOption {
  baseVersion: number
  accountId: string
  owner?: string
  repo?: string
}
interface RecordRow {
  id: number
  source_id: string
  external_id: string
  content: string
  revision: string
}
export function createNextWorkflowStore(db: Database.Database, now = Date.now) {
  const learning = createNextActionStore(db, now)
  let tools: Array<{ id: string; label: string }> = []
  const sourceRows = (): Source[] => {
    const rows = db
      .prepare(
        `SELECT g.source_id id,g.project_id projectId,p.name projectName,g.display_name label,g.grant_version baseVersion,'local' kind,'' owner,'' repo FROM source_grants g JOIN projects p ON p.id=g.project_id WHERE g.revoked=0
      UNION ALL SELECT g.source_id,g.project_id,p.name,'飞书会话',g.grant_version,'feishu','','' FROM feishu_connections g JOIN projects p ON p.id=g.project_id WHERE g.revoked=0 AND g.enabled=1
      UNION ALL SELECT g.source_id,g.project_id,p.name,g.owner||'/'||g.repo,g.grant_version,'github',g.owner,g.repo FROM github_connections g JOIN projects p ON p.id=g.project_id WHERE g.revoked=0 AND g.enabled=1
      UNION ALL SELECT g.source_instance_id,g.project_id,p.name,g.display_name,g.grant_version,'plugin','','' FROM plugin_bindings g JOIN projects p ON p.id=g.project_id WHERE g.enabled=1 AND g.uninstalled=0`,
      )
      .all() as Array<
      Omit<Source, 'appId' | 'selected' | 'accountId'> & { kind: string }
    >
    const selected = new Map(
      (
        db
          .prepare('SELECT source_id,base_version FROM next_action_scopes')
          .all() as { source_id: string; base_version: number }[]
      ).map((x) => [x.source_id, x.base_version]),
    )
    return rows.map((r) => ({
      ...r,
      accountId: 'personal-workspace',
      selected: selected.get(r.id) === r.baseVersion,
      appId:
        r.kind === 'local'
          ? r.label.startsWith('Codex 会话')
            ? 'codex'
            : r.label.startsWith('Claude Code 会话')
              ? 'claude'
              : r.label.startsWith('Kimi 会话')
                ? 'kimi'
                : 'files'
          : r.kind,
    }))
  }
  const bump = () =>
    db
      .prepare('UPDATE next_action_state SET version=version+1 WHERE id=1')
      .run()
  const reconcile = () => {
    const available = new Map(sourceRows().map((s) => [s.id, s]))
    for (const row of db
      .prepare(
        'SELECT source_id,project_id,base_version FROM next_action_scopes',
      )
      .all() as {
      source_id: string
      project_id: string
      base_version: number
    }[]) {
      if (available.get(row.source_id)?.baseVersion !== row.base_version) {
        learning.revoke(row.project_id, 'personal-workspace', row.source_id)
        db.prepare('DELETE FROM next_action_scopes WHERE source_id=?').run(
          row.source_id,
        )
      }
    }
    const invalid = db
      .prepare(
        `DELETE FROM next_action_events WHERE source_id IN (SELECT source_id FROM next_action_scopes)
      AND NOT EXISTS(SELECT 1 FROM source_events e WHERE e.id=json_extract(next_action_events.payload,'$.revision') AND e.source_id=next_action_events.source_id AND e.external_id=next_action_events.object_id
        AND COALESCE(e.operation,'upsert')!='retract' AND NOT EXISTS(SELECT 1 FROM source_events n WHERE n.source_id=e.source_id AND n.external_id=e.external_id AND n.id>e.id))`,
      )
      .run()
    const staleContributions = db
      .prepare(
        `DELETE FROM next_action_contributions WHERE
      json_extract(payload,'$.event.sourceId') IN (SELECT source_id FROM next_action_scopes) AND (
        NOT EXISTS(SELECT 1 FROM source_events e WHERE e.id=json_extract(next_action_contributions.payload,'$.event.revision') AND e.source_id=json_extract(next_action_contributions.payload,'$.event.sourceId') AND e.external_id=json_extract(next_action_contributions.payload,'$.event.objectId') AND COALESCE(e.operation,'upsert')!='retract' AND NOT EXISTS(SELECT 1 FROM source_events n WHERE n.source_id=e.source_id AND n.external_id=e.external_id AND n.id>e.id))
        OR EXISTS(SELECT 1 FROM json_each(next_action_contributions.payload,'$.choice.evidence') r WHERE NOT EXISTS(SELECT 1 FROM source_events e WHERE e.id=json_extract(r.value,'$.revision') AND e.source_id=json_extract(r.value,'$.sourceId') AND e.external_id=json_extract(r.value,'$.objectId') AND COALESCE(e.operation,'upsert')!='retract' AND NOT EXISTS(SELECT 1 FROM source_events n WHERE n.source_id=e.source_id AND n.external_id=e.external_id AND n.id>e.id)))
      )`,
      )
      .run()
    if (invalid.changes || staleContributions.changes) bump()
    learning.prune()
    db.prepare(
      'DELETE FROM next_action_suggestions WHERE created_at<? OR id IN (SELECT id FROM next_action_suggestions ORDER BY created_at DESC LIMIT -1 OFFSET 20)',
    ).run(now() - (learning.state().settings.historyDays ?? 30) * 86400000)
  }
  const selectedSource = (id: string) => {
    const s = sourceRows().find((s) => s.id === id && s.selected)
    if (!s) throw Error('NEXT_NOT_AUTHORIZED')
    return s
  }
  const record = (id: number): { row: RecordRow; source: Source } => {
    const row = db
      .prepare(
        `SELECT e.id,e.source_id,e.external_id,e.content,e.revision FROM source_events e WHERE e.id=? AND COALESCE(e.operation,'upsert')!='retract'
      AND NOT EXISTS(SELECT 1 FROM source_events n WHERE n.source_id=e.source_id AND n.external_id=e.external_id AND n.id>e.id)`,
      )
      .get(id) as RecordRow | undefined
    if (!row) throw Error('NOT_FOUND')
    const source = selectedSource(row.source_id)
    if (
      !db
        .prepare(
          'SELECT 1 FROM event_projects WHERE event_id=? AND project_id=?',
        )
        .get(id, source.projectId)
    )
      throw Error('NEXT_NOT_AUTHORIZED')
    return { row, source }
  }
  const grantVersion = (s: Source) => {
    const grant = learning
      .data()
      .grants.find(
        (g) => g.active && g.sourceId === s.id && g.projectId === s.projectId,
      )
    if (!grant) throw Error('NEXT_NOT_AUTHORIZED')
    return grant.revision
  }
  const context = (
    recordId: number,
    visibility: NextEvent['visibility'] = 'explicit-open',
  ) => {
    const { row, source: s } = record(recordId)
    const id = createHash('sha256')
      .update(`${s.projectId}\0${s.id}\0${row.external_id}`)
      .digest('hex')
    const event: NextEvent = {
      id,
      projectId: s.projectId,
      accountId: s.accountId,
      sourceId: s.id,
      sourceApp: s.appId,
      objectId: row.external_id,
      revision: row.id,
      grantRevision: grantVersion(s),
      visibility,
      eventType: 'unknown',
      action: 'handle',
      createdAt: now(),
    }
    const evidence: NextEvidence = {
      id: `e${row.id}`,
      revision: row.id,
      sourceId: s.id,
      grantRevision: event.grantRevision,
      objectId: row.external_id,
      projectId: s.projectId,
      accountId: s.accountId,
      side: 'source',
      text: row.content.slice(0, 3000),
    }
    return {
      event,
      evidence,
      label: row.content.replace(/\s+/g, ' ').slice(0, 80),
      recordId,
    }
  }
  const targets = (event: NextEvent): NextTarget[] => {
    const objects: NextTarget[] = []
    if (tools.some((t) => t.id === 'github'))
      for (const c of db
        .prepare(
          `SELECT e.id FROM source_events e JOIN event_projects p ON p.event_id=e.id WHERE p.project_id=? ORDER BY e.id DESC LIMIT 100`,
        )
        .all(event.projectId) as { id: number }[]) {
        try {
          const { row, source } = record(c.id)
          if (
            source.appId !== 'github' ||
            !source.owner ||
            !source.repo ||
            !/^pr:[1-9]\d*$/.test(row.external_id)
          )
            continue
          objects.push({
            id: `object:${row.id}`,
            revision: row.id,
            projectId: event.projectId,
            accountId: event.accountId,
            toolId: 'github',
            label:
              `${source.owner}/${source.repo} #${row.external_id.slice(3)} · ${row.content.replace(/\s+/g, ' ').slice(0, 60)}`.slice(
                0,
                120,
              ),
            kind: 'open-object',
          })
        } catch {
          /* withdrawn or superseded object */
        }
        if (objects.length >= 8) break
      }
    const linked = db
      .prepare(
        `SELECT DISTINCT t.id,t.title,t.version FROM tasks t WHERE t.project_id=? AND t.archived_at IS NULL AND (EXISTS(SELECT 1 FROM criteria c WHERE c.task_id=t.id AND c.origin_event_id=?) OR EXISTS(SELECT 1 FROM processing_evidence e WHERE e.task_id=t.id AND e.event_id=? AND e.reference_status='available')) LIMIT 4`,
      )
      .all(event.projectId, event.revision, event.revision) as {
      id: string
      title: string
      version: number
    }[]
    for (const t of linked)
      objects.push({
        id: `task:${t.id}`,
        revision: t.version,
        projectId: event.projectId,
        accountId: event.accountId,
        toolId: 'bugu',
        label: t.title.slice(0, 120),
        kind: 'open-object',
      })
    return [
      ...objects,
      ...tools.map((t) => ({
        id: `app:${t.id}`,
        revision: 1,
        projectId: event.projectId,
        accountId: event.accountId,
        toolId: t.id,
        label: t.label,
        kind: 'open-app' as const,
      })),
    ]
  }
  const getEvent = (id: string) => {
    const event = learning.data().events.find((e) => e.id === id)
    if (!event) throw Error('NOT_FOUND')
    const fresh = context(event.revision)
    if (
      fresh.event.id !== event.id ||
      fresh.event.grantRevision !== event.grantRevision
    )
      throw Error('NEXT_NOT_AUTHORIZED')
    return { ...fresh, event }
  }
  const suggestions = (): NextSuggestion[] =>
    (
      db
        .prepare(
          'SELECT payload FROM next_action_suggestions ORDER BY created_at DESC LIMIT 20',
        )
        .all() as { payload: string }[]
    ).map((r) => JSON.parse(r.payload))
  return {
    reconcile,
    context,
    getEvent,
    targets,
    execution(eventId: string, targetId: string) {
      const { event } = getEvent(eventId)
      const target = targets(event).find((t) => t.id === targetId)
      if (!target) throw Error('NEXT_INVALID_TARGET')
      if (targetId.startsWith('object:')) {
        const { row, source } = record(Number(targetId.slice(7)))
        if (
          !/^[\w.-]+$/.test(source.owner ?? '') ||
          !/^[\w.-]+$/.test(source.repo ?? '')
        )
          throw Error('NEXT_INVALID_TARGET')
        return {
          target,
          url: `https://github.com/${source.owner}/${source.repo}/pull/${row.external_id.slice(3)}`,
        }
      }
      if (targetId.startsWith('task:'))
        return { target, taskId: targetId.slice(5), projectId: event.projectId }
      return { target }
    },
    opened(recordId: number) {
      const { row, source } = record(recordId)
      return { recordId, label: source.label, text: row.content.slice(0, 6000) }
    },
    forgetPreference(eventId: string, scope: 'project' | 'personal') {
      const { event } = getEvent(eventId)
      for (const p of learning
        .data()
        .preferences.filter(
          (p) =>
            p.projectId === (scope === 'project' ? event.projectId : null) &&
            p.sourceApp === event.sourceApp &&
            p.eventType === event.eventType &&
            p.action === event.action,
        ))
        db.prepare('DELETE FROM next_action_preferences WHERE id=?').run(p.id)
      bump()
    },
    visibleCandidates() {
      const observed = this.observation()
      if (!observed.enabled || !learning.state().settings.enabled) return []
      return this.contexts()
        .flatMap((c) => {
          const s = selectedSource(c.sourceId)
          if (!observed.appIds.includes(s.appId)) return []
          const { row } = record(c.recordId)
          const text = row.content.replace(/\s+/g, ' ').trim()
          // Short/common text cannot identify a concrete visible business record.
          if (text.length < 48 || text.length > 1000) return []
          return [{ recordId: row.id, appId: s.appId, text }]
        })
        .slice(0, 40)
    },
    resolvePage(value: string): number | null {
      let url: URL
      try {
        url = new URL(value)
      } catch {
        return null
      }
      if (url.protocol !== 'https:' || url.username || url.password || url.port)
        return null
      // Only canonical, authorized GitHub repository objects are resolvable. No URL from message text.
      if (url.hostname !== 'github.com') return null
      const match =
        /^\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/([1-9]\d*)\/?$/.exec(
          url.pathname,
        )
      if (!match) return null
      const source = sourceRows().find(
        (s) =>
          s.selected &&
          s.appId === 'github' &&
          s.owner === match[1] &&
          s.repo === match[2],
      )
      if (!source || !this.observation().appIds.includes('github')) return null
      const externalId = `${match[3] === 'pull' ? 'pr' : 'issue'}:${match[4]}`
      const row = db
        .prepare(
          'SELECT id FROM source_events WHERE source_id=? AND external_id=? ORDER BY id DESC LIMIT 1',
        )
        .get(source.id, externalId) as { id: number } | undefined
      if (!row) return null
      try {
        record(row.id)
        return row.id
      } catch {
        return null
      }
    },
    reclassify(eventId: string, eventType: NextEventType) {
      const { event } = getEvent(eventId)
      db.transaction(() => {
        db.prepare('UPDATE next_action_events SET payload=? WHERE id=?').run(
          JSON.stringify({ ...event, eventType }),
          eventId,
        )
        for (const f of learning
          .data()
          .feedback.filter(
            (f) =>
              f.kind === 'wrong-type' &&
              learning
                .data()
                .choices.some(
                  (c) => c.id === f.choiceId && c.eventId === eventId,
                ),
          ))
          db.prepare(
            'UPDATE next_action_feedback SET payload=? WHERE id=?',
          ).run(JSON.stringify({ ...f, undone: true }), f.id)
        bump()
      })()
    },
    sources: () =>
      sourceRows().map(
        ({ baseVersion: _v, accountId: _a, owner: _o, repo: _r, ...s }) => s,
      ),
    tools: () => structuredClone(tools),
    setTools(value: Array<{ id: string; label: string }>) {
      tools = structuredClone(value)
    },
    contexts(): NextContextOption[] {
      return (
        db
          .prepare(
            `SELECT e.id FROM source_events e JOIN next_action_scopes s ON s.source_id=e.source_id WHERE COALESCE(e.operation,'upsert')!='retract' AND NOT EXISTS(SELECT 1 FROM source_events n WHERE n.source_id=e.source_id AND n.external_id=e.external_id AND n.id>e.id) ORDER BY e.id DESC LIMIT 100`,
          )
          .all() as { id: number }[]
      ).flatMap(({ id }) => {
        try {
          const { row, source } = record(id)
          return [
            {
              recordId: id,
              sourceId: source.id,
              projectId: source.projectId,
              label: source.label,
              preview: row.content.replace(/\s+/g, ' ').slice(0, 160),
            },
          ]
        } catch {
          return []
        }
      })
    },
    enroll(sourceIds: string[], expectedVersion: number) {
      db.transaction(() => {
        if (learning.state().version !== expectedVersion)
          throw Error('VERSION_CONFLICT')
        const available = sourceRows()
        if (sourceIds.some((id) => !available.some((s) => s.id === id)))
          throw Error('NEXT_NOT_AUTHORIZED')
        for (const old of learning
          .data()
          .grants.filter((g) => g.active && !sourceIds.includes(g.sourceId)))
          learning.revoke(old.projectId, old.accountId, old.sourceId)
        db.exec('DELETE FROM next_action_scopes')
        for (const id of sourceIds) {
          const s = available.find((s) => s.id === id)!
          const old = learning
            .data()
            .grants.find(
              (g) => g.sourceId === id && g.projectId === s.projectId,
            )
          if (!old?.active)
            learning.grant({
              projectId: s.projectId,
              accountId: s.accountId,
              sourceId: id,
              revision: (old?.revision ?? 0) + 1,
              active: true,
            })
          db.prepare('INSERT INTO next_action_scopes VALUES(?,?,?)').run(
            id,
            s.projectId,
            s.baseVersion,
          )
        }
        bump()
      })()
    },
    takeBudget() {
      return db.transaction(() => {
        const day = new Date(now()).toISOString().slice(0, 10)
        db.prepare('DELETE FROM next_action_budget WHERE day<?').run(day)
        const n =
          (
            db
              .prepare('SELECT calls FROM next_action_budget WHERE day=?')
              .get(day) as { calls: number } | undefined
          )?.calls ?? 0
        if (n >= 100) throw Error('NEXT_BUDGET_EXHAUSTED')
        db.prepare(
          'INSERT INTO next_action_budget VALUES(?,1) ON CONFLICT(day) DO UPDATE SET calls=calls+1',
        ).run(day)
      })()
    },
    suggestions,
    offer(event: NextEvent, target: NextTarget) {
      const s: NextSuggestion = {
        id: randomUUID(),
        eventId: event.id,
        targetId: target.id,
        label:
          target.kind === 'open-app' ? `打开 ${target.label}` : target.label,
        createdAt: now(),
        expiresAt: now() + 30000,
        state: 'offered',
      }
      db.prepare('INSERT INTO next_action_suggestions VALUES(?,?,?,?)').run(
        s.id,
        event.id,
        JSON.stringify(s),
        s.createdAt,
      )
      return s
    },
    updateSuggestion(
      id: string,
      state: NextSuggestion['state'],
      choiceId?: string,
    ) {
      const s = suggestions().find((s) => s.id === id)
      if (!s) throw Error('NOT_FOUND')
      s.state = state
      if (choiceId) s.choiceId = choiceId
      db.prepare('UPDATE next_action_suggestions SET payload=? WHERE id=?').run(
        JSON.stringify(s),
        id,
      )
    },
    prefer(eventId: string, toolId: string, scope: 'project' | 'personal') {
      const { event } = getEvent(eventId)
      if (!tools.some((t) => t.id === toolId))
        throw Error('NEXT_INVALID_TARGET')
      const p: NextPreference = {
        id: createHash('sha256')
          .update(
            `${scope === 'project' ? event.projectId : '*'}:${event.sourceApp}:${event.eventType}:${event.action}`,
          )
          .digest('hex'),
        projectId: scope === 'project' ? event.projectId : null,
        sourceApp: event.sourceApp,
        eventType: event.eventType,
        action: event.action,
        toolId,
      }
      db.prepare(
        'INSERT OR REPLACE INTO next_action_preferences VALUES(?,?,?)',
      ).run(p.id, p.projectId, JSON.stringify(p))
      bump()
    },
    observation() {
      const row = db
        .prepare('SELECT enabled,apps FROM next_action_observation WHERE id=1')
        .get() as { enabled: number; apps: string }
      return {
        enabled: !!row.enabled,
        appIds: JSON.parse(row.apps) as string[],
      }
    },
    setObservation(enabled: boolean, appIds: string[]) {
      db.prepare(
        'UPDATE next_action_observation SET enabled=?,apps=? WHERE id=1',
      ).run(+enabled, JSON.stringify(appIds))
      bump()
    },
    erase(scope: 'project' | 'source' | 'tool', id: string) {
      db.transaction(() => {
        if (scope === 'project' || scope === 'source') {
          for (const g of learning
            .data()
            .grants.filter(
              (g) => (scope === 'project' ? g.projectId : g.sourceId) === id,
            )) {
            learning.revoke(g.projectId, g.accountId, g.sourceId)
            db.prepare('DELETE FROM next_action_scopes WHERE source_id=?').run(
              g.sourceId,
            )
          }
        } else {
          db.prepare(
            "DELETE FROM next_action_contributions WHERE json_extract(payload,'$.choice.toolId')=?",
          ).run(id)
          for (const c of learning
            .data()
            .choices.filter((c) => c.toolId === id))
            db.prepare('DELETE FROM next_action_choices WHERE id=?').run(c.id)
        }
        for (const p of learning
          .data()
          .preferences.filter((p) =>
            scope === 'project'
              ? p.projectId === id
              : scope === 'tool'
                ? p.toolId === id
                : false,
          ))
          db.prepare('DELETE FROM next_action_preferences WHERE id=?').run(p.id)
        bump()
      })()
    },
    clear() {
      db.exec(
        "DELETE FROM next_action_scopes; DELETE FROM next_action_suggestions; UPDATE next_action_observation SET enabled=0,apps='[]'",
      )
    },
  }
}

import type Database from 'better-sqlite3'

export function migrateNextContributions(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE next_action_contributions(
        event_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX next_action_contributions_expiry ON next_action_contributions(expires_at);
      PRAGMA user_version=28;
    `)
  })()
}

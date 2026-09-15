import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BASE_MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
        runtime TEXT NOT NULL,
        service_name TEXT,
        domain TEXT,
        ports_json TEXT NOT NULL,
        health_json TEXT NOT NULL,
        commands_json TEXT NOT NULL,
        database_json TEXT NOT NULL,
        permissions_json TEXT NOT NULL,
        environment_refs_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_projects_enabled ON projects(enabled);
    `,
  },
] as const;

export class SqliteDatabase {
  public readonly raw: DatabaseSync;

  public constructor(filename: string) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o750 });
    this.raw = new DatabaseSync(filename);
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.applyBaseMigrations();
  }

  public close(): void { this.raw.close(); }

  private applyBaseMigrations(): void {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);');
    const has = this.raw.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
    const insert = this.raw.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)');
    this.raw.exec('BEGIN IMMEDIATE;');
    try {
      for (const migration of BASE_MIGRATIONS) {
        if (has.get(migration.version) !== undefined) continue;
        this.raw.exec(migration.sql);
        insert.run(migration.version, new Date().toISOString());
      }
      this.raw.exec('COMMIT;');
    } catch (error) {
      this.raw.exec('ROLLBACK;');
      throw error;
    }
  }
}

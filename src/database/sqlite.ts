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
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        current_step TEXT,
        completed_steps_json TEXT NOT NULL,
        remaining_steps_json TEXT NOT NULL,
        files_modified_json TEXT NOT NULL,
        commands_executed_json TEXT NOT NULL,
        tests_run_json TEXT NOT NULL,
        test_results_json TEXT NOT NULL,
        last_error_json TEXT,
        checkpoint TEXT,
        resumable INTEGER NOT NULL CHECK (resumable IN (0,1)),
        git_commit_before TEXT,
        git_commit_after TEXT,
        deployment_id TEXT,
        health_check_results_json TEXT,
        rollback_state_json TEXT,
        recovery_attempts INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);

      CREATE TABLE IF NOT EXISTS task_checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        current_step TEXT,
        completed_steps_json TEXT NOT NULL,
        remaining_steps_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_task_checkpoints_task ON task_checkpoints(task_id, created_at);

      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        task_id TEXT,
        project_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        pid INTEGER,
        started_at TEXT,
        finished_at TEXT,
        status TEXT NOT NULL,
        exit_code INTEGER,
        stdout_path TEXT NOT NULL,
        stderr_path TEXT NOT NULL,
        error_json TEXT,
        FOREIGN KEY(project_id) REFERENCES projects(id),
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_task ON jobs(task_id);

      CREATE TABLE IF NOT EXISTS validation_runs (
        validation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        passed INTEGER NOT NULL CHECK (passed IN (0,1)),
        result_json TEXT NOT NULL,
        UNIQUE(task_id, project_id, attempt),
        FOREIGN KEY(task_id) REFERENCES tasks(task_id),
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(scope, idempotency_key)
      );
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

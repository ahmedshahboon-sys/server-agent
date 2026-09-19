import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { tempDir } from '../helpers.js';

describe('SqliteDatabase', () => {
  it('applies base schema exactly once', () => {
    const db = new SqliteDatabase(':memory:');
    try {
      const versions = db.raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
      assert.deepEqual(
        versions.map((row) => ({ ...row })),
        Array.from({ length: 9 }, (_, index) => ({ version: index + 1 })),
      );
      assert.doesNotThrow(() => db.raw.exec('SELECT archived_at FROM projects;'));
      assert.doesNotThrow(() => db.raw.exec('SELECT cancel_requested_at FROM persistent_operations;'));
      assert.doesNotThrow(() => db.raw.exec('SELECT * FROM tasks; SELECT * FROM jobs; SELECT * FROM idempotency_keys; SELECT * FROM deployments; SELECT * FROM health_checks; SELECT * FROM database_audit; SELECT * FROM recovery_runs; SELECT * FROM rollback_plans; SELECT * FROM mcp_audit; SELECT * FROM persistent_operations; SELECT * FROM auth_principals; SELECT * FROM auth_credentials; SELECT * FROM auth_audit; SELECT * FROM oauth_clients; SELECT * FROM oauth_authorization_codes; SELECT * FROM oauth_refresh_tokens;'));
    } finally {
      db.close();
    }
  });

  it('upgrades an existing v7 state database through v9 without replaying earlier migrations', async () => {
    const temp = await tempDir('server-agent-schema-upgrade-');
    const filename = path.join(temp.path, 'state.sqlite');
    const legacy = new DatabaseSync(filename);
    try {
      legacy.exec(`
        CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE persistent_operations(
          operation_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          operation_type TEXT NOT NULL,
          status TEXT NOT NULL,
          target_id TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          result_json TEXT,
          error_json TEXT
        );
      `);
      const insert = legacy.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)');
      for (let version = 1; version <= 7; version += 1) insert.run(version, '2026-09-18T00:00:00.000Z');
    } finally {
      legacy.close();
    }

    const upgraded = new SqliteDatabase(filename);
    try {
      const versions = upgraded.raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
      assert.deepEqual(
        versions.map((row) => ({ ...row })),
        Array.from({ length: 9 }, (_, index) => ({ version: index + 1 })),
      );
      const columns = upgraded.raw.prepare('PRAGMA table_info(persistent_operations)').all() as Array<{ name: string }>;
      assert.equal(columns.some((column) => column.name === 'cancel_requested_at'), true);
      assert.doesNotThrow(() => upgraded.raw.exec('SELECT * FROM oauth_clients; SELECT * FROM oauth_authorization_codes; SELECT * FROM oauth_refresh_tokens;'));
    } finally {
      upgraded.close();
      await temp.cleanup();
    }
  });
});

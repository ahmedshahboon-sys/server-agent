import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';

describe('SqliteDatabase', () => {
  it('applies base schema exactly once', () => {
    const db = new SqliteDatabase(':memory:');
    try {
      const versions = db.raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
      assert.deepEqual(versions.map((row) => ({ ...row })), [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }]);
      assert.doesNotThrow(() => db.raw.exec('SELECT archived_at FROM projects;'));
      assert.doesNotThrow(() => db.raw.exec('SELECT * FROM tasks; SELECT * FROM jobs; SELECT * FROM idempotency_keys; SELECT * FROM deployments; SELECT * FROM health_checks; SELECT * FROM database_audit; SELECT * FROM recovery_runs; SELECT * FROM rollback_plans; SELECT * FROM mcp_audit; SELECT * FROM persistent_operations; SELECT * FROM auth_principals; SELECT * FROM auth_credentials; SELECT * FROM auth_audit;'));
    } finally { db.close(); }
  });
});

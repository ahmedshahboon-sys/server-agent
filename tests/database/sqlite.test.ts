import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';

describe('SqliteDatabase', () => {
  it('applies base schema exactly once', () => {
    const db = new SqliteDatabase(':memory:');
    try {
      const versions = db.raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
      assert.deepEqual(versions.map((row) => ({ ...row })), [{ version: 1 }, { version: 2 }]);
      assert.doesNotThrow(() => db.raw.exec('SELECT * FROM projects;'));
      assert.doesNotThrow(() => db.raw.exec('SELECT * FROM tasks; SELECT * FROM jobs; SELECT * FROM idempotency_keys;'));
    } finally { db.close(); }
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { ValidationError } from '../../src/core/errors.js';
import { projectFixture } from '../helpers.js';

const fixedClock = { now: () => new Date('2026-09-16T00:00:00.000Z') };

describe('ProjectRegistry', () => {
  it('creates, reads, updates, lists and disables projects without secrets', () => {
    const db = new SqliteDatabase(':memory:');
    try {
      const registry = new ProjectRegistry(db, fixedClock);
      const created = registry.create(projectFixture());
      assert.equal(created.id, 'project-a');
      assert.equal(created.database.secretRef, 'PROJECT_A_DB_URL');
      assert.equal(registry.list().length, 1);
      assert.equal(registry.update('project-a', { name: 'Renamed' }).name, 'Renamed');
      assert.equal(registry.disable('project-a').enabled, false);
    } finally { db.close(); }
  });

  it('does not treat disable as filesystem deletion', () => {
    const db = new SqliteDatabase(':memory:');
    try {
      const registry = new ProjectRegistry(db, fixedClock);
      registry.create(projectFixture());
      registry.disable('project-a');
      assert.equal(registry.get('project-a')?.root, '/opt/project-a');
    } finally { db.close(); }
  });

  it('rejects non-absolute project roots', () => {
    const db = new SqliteDatabase(':memory:');
    try {
      const registry = new ProjectRegistry(db, fixedClock);
      assert.throws(() => registry.create(projectFixture({ root: '../escape' })), ValidationError);
    } finally { db.close(); }
  });

  it('rejects embedded secret-like metadata', () => {
    const db = new SqliteDatabase(':memory:');
    try {
      const registry = new ProjectRegistry(db, fixedClock);
      assert.throws(() => registry.create(projectFixture({ metadata: { apiToken: 'should-not-be-stored' } })), ValidationError);
    } finally { db.close(); }
  });

  it('rejects environment values and accepts only env-var references', () => {
    const db = new SqliteDatabase(':memory:');
    try {
      const registry = new ProjectRegistry(db, fixedClock);
      assert.throws(() => registry.create(projectFixture({ environmentRefs: ['postgres://user:password@host/db'] })), ValidationError);
    } finally { db.close(); }
  });
});

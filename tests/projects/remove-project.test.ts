import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TaskEngine } from '../../src/tasks/task-engine.js';
import { ValidationError } from '../../src/core/errors.js';
import { projectFixture, tempDir } from '../helpers.js';

test('remove_project archives registry metadata, preserves history, and never deletes project files', async () => {
  const temp = await tempDir('server-agent-remove-project-');
  const db = new SqliteDatabase(':memory:');
  try {
    const marker = path.join(temp.path, 'keep-me.txt');
    await writeFile(marker, 'still-here', 'utf8');
    const registry = new ProjectRegistry(db);
    registry.create(projectFixture({
      root: temp.path,
      health: { type: 'none' },
      database: { adapter: 'none', defaultAccess: 'read' },
      deployment: { strategy: 'none', requireClean: true, validationRequired: false, restartService: false, healthRequired: false },
      environmentRefs: [],
    }));
    const tasks = new TaskEngine(db);
    const task = tasks.create('project-a', 'historical task');

    registry.remove('project-a');

    assert.equal(registry.get('project-a'), null);
    assert.equal(registry.list().length, 0);
    assert.equal(tasks.get(task.taskId)?.projectId, 'project-a');
    assert.equal(await readFile(marker, 'utf8'), 'still-here');
    const archived = db.raw.prepare('SELECT enabled, archived_at FROM projects WHERE id=?').get('project-a') as { enabled:number; archived_at:string|null };
    assert.equal(archived.enabled, 0);
    assert.ok(archived.archived_at !== null);
    assert.throws(() => registry.create(projectFixture({ root: temp.path })), ValidationError);
  } finally {
    db.close();
    await temp.cleanup();
  }
});

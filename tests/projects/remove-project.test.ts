import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { projectFixture, tempDir } from '../helpers.js';

test('remove_project semantics delete only registry metadata and preserve project files', async () => {
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
    registry.remove('project-a');
    assert.equal(registry.get('project-a'), null);
    assert.equal(await readFile(marker, 'utf8'), 'still-here');
  } finally {
    db.close();
    await temp.cleanup();
  }
});

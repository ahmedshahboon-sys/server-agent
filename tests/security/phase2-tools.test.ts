import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { RestrictedCommandRunner } from '../../src/commands/command-runner.js';
import { ProjectFileService } from '../../src/files/file-service.js';
import { AuthorizationError, CommandDeniedError } from '../../src/core/errors.js';
import { projectFixture, tempDir } from '../helpers.js';

test('phase 2 tools reject unconfigured commands and cross-project file access', async () => {
  const temp = await tempDir('server-agent-phase2-security-');
  const db = new SqliteDatabase(':memory:');
  const registry = new ProjectRegistry(db);
  registry.create(projectFixture({
    root: temp.path,
    permissions: ['commands:run', 'files:read'],
    commands: { allowed: { safe: ['node', '-e', 'process.stdout.write("ok")'] } },
  }));
  const authorizer = new DefaultDenyAuthorizer();
  const runner = new RestrictedCommandRunner(registry, authorizer, { timeoutMs: 1000, maxOutputBytes: 1024 });
  const files = new ProjectFileService(registry, authorizer, { maxFileBytes: 1024 });
  const commandPrincipal = { id: 'p', kind: 'local' as const, projectScopes: ['project-a'], permissions: ['commands:run'] as const };
  const wrongProjectPrincipal = { id: 'p', kind: 'local' as const, projectScopes: ['project-b'], permissions: ['files:read'] as const };
  try {
    await assert.rejects(runner.run('project-a', commandPrincipal, 'safe; rm -rf /'), CommandDeniedError);
    await assert.rejects(files.readFile('project-a', wrongProjectPrincipal, 'README.md'), AuthorizationError);
  } finally { db.close(); await temp.cleanup(); }
});

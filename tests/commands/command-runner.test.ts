import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { RestrictedCommandRunner } from '../../src/commands/command-runner.js';
import { CommandDeniedError, CommandTimeoutError } from '../../src/core/errors.js';
import { projectFixture, tempDir } from '../helpers.js';

const principal = { id:'tester', kind:'local' as const, projectScopes:['project-a'], permissions:['commands:run'] as const };

async function setup(commands: Record<string, readonly string[]>, env: NodeJS.ProcessEnv = process.env) {
  const temp = await tempDir('server-agent-command-');
  const db = new SqliteDatabase(':memory:');
  const registry = new ProjectRegistry(db);
  registry.create(projectFixture({ root: temp.path, permissions:['commands:run'], environmentRefs:['PROJECT_SECRET'], commands:{ allowed: commands } }));
  const runner = new RestrictedCommandRunner(registry, new DefaultDenyAuthorizer(), { timeoutMs: 250, maxOutputBytes: 64, environment: env });
  return { temp, db, runner };
}

test('runs only configured argv without a shell', async () => {
  const { temp, db, runner } = await setup({ hello: ['node','-e','process.stdout.write(process.argv[1])','hello;touch /tmp/should-not-run'] });
  try {
    const result = await runner.run('project-a', principal, 'hello');
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /hello;touch/);
  } finally { db.close(); await temp.cleanup(); }
});

test('blocks dangerous configured executables', async () => {
  const { temp, db, runner } = await setup({ danger: ['sh','-c','echo nope'] });
  try { await assert.rejects(runner.run('project-a', principal, 'danger'), CommandDeniedError); }
  finally { db.close(); await temp.cleanup(); }
});

test('enforces timeout', async () => {
  const { temp, db, runner } = await setup({ slow: ['node','-e','setTimeout(()=>{},5000)'] });
  try { await assert.rejects(runner.run('project-a', principal, 'slow'), CommandTimeoutError); }
  finally { db.close(); await temp.cleanup(); }
});

test('limits output and redacts explicitly injected project secrets', async () => {
  const secret='super-secret-value-123';
  const { temp, db, runner } = await setup({ noisy: ['node','-e','process.stdout.write(String(process.env.PROJECT_SECRET)+"\\n"+"x".repeat(1000))'] }, { ...process.env, PROJECT_SECRET: secret });
  try {
    const result = await runner.run('project-a', principal, 'noisy');
    assert.equal(result.stdout.includes(secret), false);
    assert.match(result.stdout, /\[REDACTED\]/);
    assert.equal(result.stdoutTruncated, true);
    assert.ok(Buffer.byteLength(result.stdout) <= 80);
  } finally { db.close(); await temp.cleanup(); }
});

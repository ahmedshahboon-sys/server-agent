import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { AuthenticationError, AuthorizationError, CommandDeniedError } from '../../src/core/errors.js';
import { currentIdempotencyKey } from '../../src/idempotency/context.js';
import { StaticBearerAuthenticator } from '../../src/mcp/auth.js';
import { McpToolRegistry } from '../../src/mcp/tool-registry.js';
import { MCP_PROTOCOL_VERSION, McpHttpTransport } from '../../src/mcp/transport.js';
import { RestrictedCommandRunner } from '../../src/commands/command-runner.js';
import { assessMigrationRollback } from '../../src/recovery/migration-safety.js';
import { projectFixture } from '../helpers.js';

const token = 'phase4-test-token-0123456789abcdef';
const authorizer = new DefaultDenyAuthorizer();

test('MCP bearer authentication rejects missing and incorrect credentials', async () => {
  const principal = { id: 'remote-a', kind: 'remote' as const, projectScopes: ['project-a'], permissions: ['project:read'] as const };
  const auth = new StaticBearerAuthenticator(token, principal);
  await assert.rejects(auth.authenticate({}), AuthenticationError);
  await assert.rejects(auth.authenticate({ authorization: 'Bearer wrong-token-value-0123456789' }), AuthenticationError);
  assert.equal(await auth.authenticate({ authorization: `Bearer ${token}` }), principal);
});

test('MCP registry denies cross-project access, audits denial, and redacts tool results', async () => {
  const db = new SqliteDatabase(':memory:');
  try {
    const tools = new McpToolRegistry(authorizer, db);
    tools.register({
      definition: { name: 'phase4_probe', description: 'phase4 test probe', inputSchema: { type: 'object' } },
      permission: 'files:read', projectArgument: 'project_id',
      handler: async () => ({ apiToken: 'do-not-leak', nested: { secret: 'also-private' }, ok: true }),
    });
    const principal = { id: 'remote-a', kind: 'remote' as const, projectScopes: ['project-a'], permissions: ['files:read'] as const };
    await assert.rejects(tools.call('phase4_probe', { project_id: 'project-b' }, { principal, requestId: 1 }), AuthorizationError);
    const denied = db.raw.prepare('SELECT success,error_code,project_id FROM mcp_audit ORDER BY created_at DESC LIMIT 1').get() as { success:number; error_code:string; project_id:string };
    assert.equal(denied.success, 0);
    assert.equal(denied.error_code, 'AUTHORIZATION_DENIED');
    assert.equal(denied.project_id, 'project-b');
    const result = await tools.call('phase4_probe', { project_id: 'project-a' }, { principal, requestId: 2 }) as Record<string, unknown>;
    assert.equal(result['apiToken'], '[REDACTED]');
    assert.deepEqual(result['nested'], { secret: '[REDACTED]' });
  } finally { db.close(); }
});

test('MCP tool calls propagate stable request idempotency context and explicit overrides', async () => {
  const tools = new McpToolRegistry(authorizer);
  tools.register({
    definition: { name: 'idempotency_probe', description: 'idempotency context probe', inputSchema: { type: 'object' } },
    permission: 'project:read',
    handler: async () => ({ key: currentIdempotencyKey() ?? null }),
  });
  const principal = { id: 'remote-a', kind: 'remote' as const, projectScopes: ['project-a'], permissions: ['project:read'] as const };
  const first = await tools.call('idempotency_probe', {}, { principal, requestId: 'request-42' }) as { key:string };
  const replay = await tools.call('idempotency_probe', {}, { principal, requestId: 'request-42' }) as { key:string };
  assert.equal(first.key, replay.key);
  assert.match(first.key, /^req:[a-f0-9]{48}$/);
  const explicit = await tools.call('idempotency_probe', { idempotency_key: 'explicit-key-1' }, { principal, requestId: 'request-43' }) as { key:string };
  assert.equal(explicit.key, 'explicit-key-1');
});

test('MCP HTTP transport enforces Origin, auth, modern protocol metadata, and secret-safe responses', async () => {
  const tools = new McpToolRegistry(authorizer);
  tools.register({
    definition: { name: 'safe_probe', description: 'safe test probe', inputSchema: { type: 'object' } },
    permission: 'project:read',
    handler: async () => ({ credential: 'never-return-this', ok: true }),
  });
  const principal = { id: 'remote-a', kind: 'remote' as const, projectScopes: ['project-a'], permissions: ['project:read'] as const };
  const transport = new McpHttpTransport(new StaticBearerAuthenticator(token, principal), tools, { path: '/mcp', maxBodyBytes: 16_384, allowedOrigins: ['https://chatgpt.com'] });
  const validMeta = { 'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION, 'io.modelcontextprotocol/clientCapabilities': {} };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'safe_probe', arguments: {}, _meta: validMeta } });
  const missingCapabilitiesBody = JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'safe_probe', arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION } } });
  const baseHeaders = { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'mcp-protocol-version': MCP_PROTOCOL_VERSION, 'mcp-method': 'tools/call', 'mcp-name': 'safe_probe' };
  const missingCapabilities = await transport.handle({ method: 'POST', path: '/mcp', headers: { ...baseHeaders, origin: 'https://chatgpt.com' }, body: missingCapabilitiesBody });
  assert.equal(missingCapabilities.status, 400);
  const badOrigin = await transport.handle({ method: 'POST', path: '/mcp', headers: { ...baseHeaders, origin: 'https://evil.example' }, body });
  assert.equal(badOrigin.status, 403);
  const badAuth = await transport.handle({ method: 'POST', path: '/mcp', headers: { ...baseHeaders, authorization: 'Bearer wrong-token-value-0123456789', origin: 'https://chatgpt.com' }, body });
  assert.equal(badAuth.status, 401);
  const ok = await transport.handle({ method: 'POST', path: '/mcp', headers: { ...baseHeaders, origin: 'https://chatgpt.com' }, body });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.includes('never-return-this'), false);
  assert.equal(ok.body.includes('[REDACTED]'), true);
});

test('generic run_command path cannot execute the registered rollback command', async () => {
  const db = new SqliteDatabase(':memory:');
  try {
    const projects = new ProjectRegistry(db);
    projects.create(projectFixture({
      permissions: ['commands:run'],
      commands: { rollback: ['node', 'rollback.mjs', '{target_commit}'] },
      health: { type: 'none' },
      database: { adapter: 'none', defaultAccess: 'read' },
      deployment: { strategy: 'none', requireClean: true, validationRequired: false, restartService: false, healthRequired: false },
    }));
    const runner = new RestrictedCommandRunner(projects, authorizer, { timeoutMs: 1000, maxOutputBytes: 4096 });
    const principal = { id: 'operator', kind: 'local' as const, projectScopes: ['project-a'], permissions: ['commands:run'] as const };
    await assert.rejects(runner.run('project-a', principal, 'rollback'), CommandDeniedError);
  } finally { db.close(); }
});

test('migration rollback safety never assumes database rollback across version changes', () => {
  const before = { known: true, system: 'prisma', current: '202609150001', pending: 0, details: {} };
  const same = { known: true, system: 'prisma', current: '202609150001', pending: 0, details: {} };
  const changed = { known: true, system: 'prisma', current: '202609160001', pending: 0, details: {} };
  assert.equal(assessMigrationRollback('postgresql', before, same).safety, 'SAFE');
  assert.equal(assessMigrationRollback('postgresql', before, changed).safety, 'MANUAL_REQUIRED');
  assert.equal(assessMigrationRollback('postgresql', null, changed).safety, 'MANUAL_REQUIRED');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntimeAuthentication } from '../../src/runtime/auth.js';
import { AuthenticationError, ValidationError } from '../../src/core/errors.js';

const token = 'phase5-runtime-token-0123456789abcdef';

test('runtime authentication requires a strong bearer token and explicit scopes/permissions', () => {
  assert.throws(() => loadRuntimeAuthentication({ SERVER_AGENT_MCP_PROJECT_SCOPES: '*', SERVER_AGENT_MCP_PERMISSIONS: 'project:read' }), AuthenticationError);
  assert.throws(() => loadRuntimeAuthentication({ SERVER_AGENT_MCP_BEARER_TOKEN: token, SERVER_AGENT_MCP_PERMISSIONS: 'project:read' }), ValidationError);
  assert.throws(() => loadRuntimeAuthentication({ SERVER_AGENT_MCP_BEARER_TOKEN: token, SERVER_AGENT_MCP_PROJECT_SCOPES: '*' }), ValidationError);
});

test('runtime authentication creates a least-privilege remote principal without embedding the token', () => {
  const result = loadRuntimeAuthentication({
    SERVER_AGENT_MCP_BEARER_TOKEN: token,
    SERVER_AGENT_MCP_PRINCIPAL_ID: 'chatgpt-remote',
    SERVER_AGENT_MCP_PROJECT_SCOPES: 'project-a,project-b',
    SERVER_AGENT_MCP_PERMISSIONS: 'project:read,files:read,commands:run',
  });
  assert.equal(result.token, token);
  assert.equal(result.credentialId, 'bootstrap-chatgpt');
  assert.equal(result.expiresAt, null);
  assert.deepEqual(result.principal.projectScopes, ['project-a', 'project-b']);
  assert.deepEqual(result.principal.permissions, ['project:read', 'files:read', 'commands:run']);
  assert.equal(JSON.stringify(result.principal).includes(token), false);
});

test('runtime authentication rejects unknown permissions and malformed scopes', () => {
  assert.throws(() => loadRuntimeAuthentication({ SERVER_AGENT_MCP_BEARER_TOKEN: token, SERVER_AGENT_MCP_PROJECT_SCOPES: '*', SERVER_AGENT_MCP_PERMISSIONS: 'root:shell' }), ValidationError);
  assert.throws(() => loadRuntimeAuthentication({ SERVER_AGENT_MCP_BEARER_TOKEN: token, SERVER_AGENT_MCP_PROJECT_SCOPES: '../escape', SERVER_AGENT_MCP_PERMISSIONS: 'project:read' }), ValidationError);
});

test('runtime authentication accepts fine-grained management permissions and rejects removed broad project:manage', () => {
  const result = loadRuntimeAuthentication({
    SERVER_AGENT_MCP_BEARER_TOKEN: token,
    SERVER_AGENT_MCP_PROJECT_SCOPES: '*',
    SERVER_AGENT_MCP_PERMISSIONS: 'project:read,project:update:commands,project:update:root',
  });
  assert.deepEqual(result.principal.permissions, ['project:read','project:update:commands','project:update:root']);
  assert.throws(() => loadRuntimeAuthentication({
    SERVER_AGENT_MCP_BEARER_TOKEN: token,
    SERVER_AGENT_MCP_PROJECT_SCOPES: '*',
    SERVER_AGENT_MCP_PERMISSIONS: 'project:manage',
  }), ValidationError);
});

test('runtime authentication validates bootstrap credential id and expiry metadata', () => {
  const result = loadRuntimeAuthentication({
    SERVER_AGENT_MCP_BEARER_TOKEN: token,
    SERVER_AGENT_MCP_PRINCIPAL_ID: 'chatgpt-remote',
    SERVER_AGENT_MCP_CREDENTIAL_ID: 'credential-2026-09',
    SERVER_AGENT_MCP_CREDENTIAL_EXPIRES_AT: '2026-12-31T23:59:59Z',
    SERVER_AGENT_MCP_PROJECT_SCOPES: 'project-a',
    SERVER_AGENT_MCP_PERMISSIONS: 'project:read',
  });
  assert.equal(result.credentialId, 'credential-2026-09');
  assert.equal(result.expiresAt, '2026-12-31T23:59:59.000Z');
  assert.throws(() => loadRuntimeAuthentication({
    SERVER_AGENT_MCP_BEARER_TOKEN: token,
    SERVER_AGENT_MCP_CREDENTIAL_ID: '../bad',
    SERVER_AGENT_MCP_PROJECT_SCOPES: 'project-a',
    SERVER_AGENT_MCP_PERMISSIONS: 'project:read',
  }), ValidationError);
});

test('runtime rejects the public example bearer placeholder even outside the installer', () => {
  assert.throws(() => loadRuntimeAuthentication({
    SERVER_AGENT_MCP_BEARER_TOKEN: 'CHANGE_ME_WITH_32_PLUS_RANDOM_CHARACTERS',
    SERVER_AGENT_MCP_PROJECT_SCOPES: 'project-a',
    SERVER_AGENT_MCP_PERMISSIONS: 'project:read',
  }), AuthenticationError);
});

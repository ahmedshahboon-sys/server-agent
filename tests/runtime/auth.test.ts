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
  assert.deepEqual(result.principal.projectScopes, ['project-a', 'project-b']);
  assert.deepEqual(result.principal.permissions, ['project:read', 'files:read', 'commands:run']);
  assert.equal(JSON.stringify(result.principal).includes(token), false);
});

test('runtime authentication rejects unknown permissions and malformed scopes', () => {
  assert.throws(() => loadRuntimeAuthentication({ SERVER_AGENT_MCP_BEARER_TOKEN: token, SERVER_AGENT_MCP_PROJECT_SCOPES: '*', SERVER_AGENT_MCP_PERMISSIONS: 'root:shell' }), ValidationError);
  assert.throws(() => loadRuntimeAuthentication({ SERVER_AGENT_MCP_BEARER_TOKEN: token, SERVER_AGENT_MCP_PROJECT_SCOPES: '../escape', SERVER_AGENT_MCP_PERMISSIONS: 'project:read' }), ValidationError);
});

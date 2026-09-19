import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Phase 5 install package is non-root, local-bind-first, and non-destructive by default', () => {
  const unit = readFileSync('install/systemd/server-agent.service.template', 'utf8');
  const env = readFileSync('install/server-agent.env.example', 'utf8');
  const installer = readFileSync('install/install.sh', 'utf8');
  const uninstaller = readFileSync('install/uninstall.sh', 'utf8');

  assert.match(unit, /^User=@@USER@@$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^CapabilityBoundingSet=$/m);
  assert.doesNotMatch(unit, /^User=root$/m);
  assert.match(env, /^SERVER_AGENT_MCP_HOST=127\.0\.0\.1$/m);
  assert.match(env, /^SERVER_AGENT_MCP_ALLOW_PUBLIC_BIND=false$/m);
  assert.match(env, /^SERVER_AGENT_MCP_PROJECT_SCOPES=example-project$/m);
  assert.doesNotMatch(env, /^SERVER_AGENT_MCP_PROJECT_SCOPES=\*$/m);
  assert.match(env, /^SERVER_AGENT_MAX_CONCURRENT_JOBS=1$/m);
  assert.match(installer, /ENABLE_SERVICE=0/);
  assert.match(installer, /--enable/);
  assert.doesNotMatch(installer, /rm\s+-rf\b/);
  assert.doesNotMatch(uninstaller, /rm\s+-rf\b/);
  assert.match(uninstaller, /Preserved intentionally/);
});

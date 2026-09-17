import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/config.js';
import { ValidationError } from '../src/core/errors.js';

describe('loadConfig', () => {
  it('uses safe local defaults without production assumptions', () => {
    const config = loadConfig({});
    assert.equal(config.dbPath.endsWith('server-agent.sqlite'), true);
    assert.equal(config.maxFileBytes, 1_048_576);
    assert.equal(config.maxCommandOutputBytes, 262_144);
    assert.equal(config.commandTimeoutMs, 120_000);
    assert.equal(config.maxFixAttempts, 3);
    assert.equal(config.maxConcurrentJobs, 1);
    assert.equal(config.databaseQueryTimeoutMs, 10_000);
    assert.equal(config.databaseMaxRows, 500);
    assert.equal(config.maxRecoveryAttempts, 3);
    assert.equal(config.mcpHost, '127.0.0.1');
    assert.equal(config.mcpPort, 8765);
    assert.equal(config.mcpPath, '/mcp');
    assert.equal(config.mcpAllowPublicBind, false);
  });

  it('rejects invalid values, excessive resource limits, and accidental public bind', () => {
    assert.throws(() => loadConfig({ SERVER_AGENT_MAX_FILE_BYTES: '-1' }), ValidationError);
    assert.throws(() => loadConfig({ SERVER_AGENT_MAX_FILE_BYTES: '16777217' }), ValidationError);
    assert.throws(() => loadConfig({ SERVER_AGENT_MAX_COMMAND_OUTPUT_BYTES: '4194305' }), ValidationError);
    assert.throws(() => loadConfig({ SERVER_AGENT_COMMAND_TIMEOUT_MS: '1800001' }), ValidationError);
    assert.throws(() => loadConfig({ SERVER_AGENT_MAX_CONCURRENT_JOBS: '9' }), ValidationError);
    assert.throws(() => loadConfig({ SERVER_AGENT_DATABASE_MAX_ROWS: '10001' }), ValidationError);
    assert.throws(() => loadConfig({ SERVER_AGENT_MCP_MAX_BODY_BYTES: '4194305' }), ValidationError);
    assert.throws(() => loadConfig({ SERVER_AGENT_MAX_FIX_ATTEMPTS: '0' }), ValidationError);
    assert.throws(() => loadConfig({ SERVER_AGENT_LOG_LEVEL: 'trace' }), ValidationError);
    assert.throws(() => loadConfig({ SERVER_AGENT_MCP_ALLOW_PUBLIC_BIND: 'yes' }), ValidationError);
    assert.throws(() => loadConfig({ SERVER_AGENT_MCP_HOST: '0.0.0.0' }), ValidationError);
  });

  it('requires an explicit opt-in before binding MCP beyond loopback', () => {
    const config = loadConfig({ SERVER_AGENT_MCP_HOST: '0.0.0.0', SERVER_AGENT_MCP_ALLOW_PUBLIC_BIND: 'true' });
    assert.equal(config.mcpHost, '0.0.0.0');
    assert.equal(config.mcpAllowPublicBind, true);
  });
});

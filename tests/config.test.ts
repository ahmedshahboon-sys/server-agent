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
  });

  it('rejects invalid bounded values', () => {
    assert.throws(() => loadConfig({ SERVER_AGENT_MAX_FILE_BYTES: '-1' }), ValidationError);
    assert.throws(() => loadConfig({ SERVER_AGENT_MAX_FIX_ATTEMPTS: '0' }), ValidationError);
    assert.throws(() => loadConfig({ SERVER_AGENT_LOG_LEVEL: 'trace' }), ValidationError);
  });
});

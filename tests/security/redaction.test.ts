import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, redactString, redactValue } from '../../src/security/redaction.js';

describe('secret redaction', () => {
  it('redacts secret-like object keys recursively', () => {
    const value = redactValue({ user: 'demo', password: 'hidden', nested: { api_key: 'hidden2', safe: 'ok' } });
    assert.deepEqual(value, { user: 'demo', password: REDACTED, nested: { api_key: REDACTED, safe: 'ok' } });
  });

  it('redacts bearer tokens, assignments and credential URLs in strings', () => {
    const output = redactString('Bearer abc.def TOKEN=abc123 postgres://user:pass@localhost/db');
    assert.equal(output.includes('abc.def'), false);
    assert.equal(output.includes('abc123'), false);
    assert.equal(output.includes('user:pass'), false);
    assert.equal(output.includes(REDACTED), true);
  });

  it('redacts private key blocks', () => {
    const output = redactString('before -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY----- after');
    assert.equal(output.includes('abc'), false);
    assert.equal(output.includes(REDACTED), true);
  });
});

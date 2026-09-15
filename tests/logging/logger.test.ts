import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StructuredLogger, type StructuredLogRecord } from '../../src/logging/logger.js';
import { REDACTED } from '../../src/security/redaction.js';

describe('StructuredLogger', () => {
  it('redacts secrets before passing records to a sink', () => {
    const records: StructuredLogRecord[] = [];
    const logger = new StructuredLogger('debug', (record) => records.push(record));
    logger.info('request Bearer top.secret', { task_id: 'task-1', password: 'hidden', safe: 'visible' });
    assert.equal(JSON.stringify(records).includes('top.secret'), false);
    assert.equal(JSON.stringify(records).includes('hidden'), false);
    assert.equal(records[0]?.context?.password, REDACTED);
    assert.equal(records[0]?.context?.safe, 'visible');
  });

  it('honors the configured minimum log level', () => {
    const records: StructuredLogRecord[] = [];
    const logger = new StructuredLogger('warn', (record) => records.push(record));
    logger.info('ignored');
    logger.warn('kept');
    assert.deepEqual(records.map((record) => record.message), ['kept']);
  });
});

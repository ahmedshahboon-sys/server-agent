import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNonDestructiveSql, classifySql } from '../../src/database/sql-safety.js';
import { DestructiveOperationError, ValidationError } from '../../src/core/errors.js';

test('classifies read and controlled write SQL', () => {
  assert.equal(classifySql('SELECT * FROM users').classification, 'READ');
  assert.equal(classifySql('-- comment\nSELECT 1').classification, 'READ');
  assert.equal(classifySql('UPDATE users SET name=? WHERE id=?').classification, 'WRITE');
  assert.equal(classifySql('DELETE FROM users WHERE id=?').classification, 'WRITE');
  assert.equal(classifySql('WITH q AS (SELECT 1) SELECT * FROM q').classification, 'READ');
});

test('blocks destructive SQL and manual transaction control', () => {
  assert.equal(classifySql('DELETE FROM users').classification, 'DESTRUCTIVE');
  assert.equal(classifySql('DROP TABLE users').classification, 'DESTRUCTIVE');
  assert.equal(classifySql('TRUNCATE users').classification, 'DESTRUCTIVE');
  assert.throws(() => assertNonDestructiveSql('DROP DATABASE app'), DestructiveOperationError);
  assert.throws(() => assertNonDestructiveSql('BEGIN'), ValidationError);
});

test('rejects multiple statements in database_query', () => {
  assert.throws(() => classifySql('SELECT 1; DELETE FROM users WHERE id=1'), ValidationError);
});

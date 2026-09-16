import type { DatabaseQueryClassification } from '../core/types.js';
import { DestructiveOperationError, ValidationError } from '../core/errors.js';

export interface SqlClassification {
  readonly classification: DatabaseQueryClassification;
  readonly normalizedVerb: string;
  readonly reason: string;
}

function stripLeadingComments(sql: string): string {
  let value = sql.trim();
  while (true) {
    const line = value.match(/^--[^\n]*(?:\n|$)/);
    if (line !== null) { value = value.slice(line[0].length).trimStart(); continue; }
    const block = value.match(/^\/\*[\s\S]*?\*\//);
    if (block !== null) { value = value.slice(block[0].length).trimStart(); continue; }
    return value;
  }
}

function containsMultipleStatements(sql: string): boolean {
  let single = false; let double = false; let backtick = false; let lineComment = false; let blockComment = false;
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i]; const n = sql[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i += 1; } continue; }
    if (!single && !double && !backtick && c === '-' && n === '-') { lineComment = true; i += 1; continue; }
    if (!single && !double && !backtick && c === '/' && n === '*') { blockComment = true; i += 1; continue; }
    if (!double && !backtick && c === "'") { if (single && n === "'") { i += 1; continue; } single = !single; continue; }
    if (!single && !backtick && c === '"') { double = !double; continue; }
    if (!single && !double && c === '`') { backtick = !backtick; continue; }
    if (!single && !double && !backtick && c === ';' && sql.slice(i + 1).trim() !== '') return true;
  }
  return false;
}

function classifyWith(sql: string): SqlClassification {
  const upper = sql.toUpperCase();
  const destructive = /\b(DROP\s+(?:DATABASE|TABLE|SCHEMA)|TRUNCATE\b|ALTER\s+TABLE\b[\s\S]*\bDROP\b)/i;
  if (destructive.test(sql)) return { classification: 'DESTRUCTIVE', normalizedVerb: 'WITH', reason: 'destructive statement inside CTE' };
  if (/\b(INSERT|UPDATE|DELETE|REPLACE|MERGE)\b/i.test(sql)) {
    if (/\bDELETE\s+FROM\b/i.test(sql) && !/\bWHERE\b/i.test(sql)) return { classification: 'DESTRUCTIVE', normalizedVerb: 'DELETE', reason: 'DELETE without WHERE' };
    return { classification: 'WRITE', normalizedVerb: upper.match(/\b(INSERT|UPDATE|DELETE|REPLACE|MERGE)\b/)?.[1] ?? 'WRITE', reason: 'write CTE' };
  }
  if (/\bSELECT\b/i.test(sql)) return { classification: 'READ', normalizedVerb: 'SELECT', reason: 'read CTE' };
  return { classification: 'UNKNOWN', normalizedVerb: 'WITH', reason: 'unrecognized CTE' };
}

export function classifySql(input: string): SqlClassification {
  if (input.trim() === '') throw new ValidationError('SQL query is required');
  if (input.includes('\0')) throw new ValidationError('SQL query contains a null byte');
  if (containsMultipleStatements(input)) throw new ValidationError('Multiple SQL statements are not allowed in database_query');
  const sql = stripLeadingComments(input).replace(/;\s*$/, '').trim();
  const match = sql.match(/^([A-Za-z]+)/);
  const verb = match?.[1]?.toUpperCase() ?? '';
  if (verb === 'WITH') return classifyWith(sql);
  if (['SELECT', 'EXPLAIN', 'SHOW', 'DESCRIBE'].includes(verb)) return { classification: 'READ', normalizedVerb: verb, reason: 'read statement' };
  if (verb === 'PRAGMA') {
    if (/^PRAGMA\s+[A-Za-z0-9_]+\s*(?:;)?$/i.test(sql)) return { classification: 'READ', normalizedVerb: verb, reason: 'read-only pragma' };
    return { classification: 'UNKNOWN', normalizedVerb: verb, reason: 'pragma mutation is not allowed' };
  }
  if (['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'].includes(verb)) return { classification: 'TRANSACTION_CONTROL', normalizedVerb: verb, reason: 'transaction control is managed by Server Agent' };
  if (verb === 'DELETE' && !/\bWHERE\b/i.test(sql)) return { classification: 'DESTRUCTIVE', normalizedVerb: verb, reason: 'DELETE without WHERE' };
  if (verb === 'DROP' || verb === 'TRUNCATE') return { classification: 'DESTRUCTIVE', normalizedVerb: verb, reason: 'destructive DDL' };
  if (verb === 'ALTER' && /\bDROP\b/i.test(sql)) return { classification: 'DESTRUCTIVE', normalizedVerb: verb, reason: 'destructive ALTER' };
  if (['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'ALTER'].includes(verb)) return { classification: 'WRITE', normalizedVerb: verb, reason: 'write statement' };
  return { classification: 'UNKNOWN', normalizedVerb: verb || 'UNKNOWN', reason: 'unrecognized SQL statement' };
}

export function assertNonDestructiveSql(sql: string): SqlClassification {
  const result = classifySql(sql);
  if (result.classification === 'DESTRUCTIVE') throw new DestructiveOperationError(result.reason);
  if (result.classification === 'TRANSACTION_CONTROL') throw new ValidationError('Transaction control statements must use database_transaction');
  if (result.classification === 'UNKNOWN') throw new ValidationError(`SQL statement is not allowed: ${result.reason}`);
  return result;
}

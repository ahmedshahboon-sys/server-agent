import { createHash } from 'node:crypto';
import type { SqliteDatabase } from '../database/sqlite.js';
import { ConflictError, ValidationError } from '../core/errors.js';
import { redactValue } from '../security/redaction.js';

export type IdempotencyStatus = 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
export interface IdempotencyRecord {
  readonly scope: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly status: IdempotencyStatus;
  readonly result: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type Row = { scope:string; idempotency_key:string; fingerprint:string; status:IdempotencyStatus; result_json:string|null; created_at:string; updated_at:string };
function map(row: Row): IdempotencyRecord {
  return { scope: row.scope, key: row.idempotency_key, fingerprint: row.fingerprint, status: row.status, result: row.result_json === null ? null : JSON.parse(row.result_json), createdAt: row.created_at, updatedAt: row.updated_at };
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') { const encoded=JSON.stringify(value); return encoded===undefined?String(value):encoded; }
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value instanceof Uint8Array) return `"bytes:${Buffer.from(value).toString('base64')}"`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

export function idempotencyFingerprint(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

export class IdempotencyStore {
  public constructor(private readonly db: SqliteDatabase) {}

  public begin(scope: string, key: string, fingerprint: string): { readonly created: boolean; readonly record: IdempotencyRecord } {
    if (scope.trim() === '' || key.trim() === '' || fingerprint.trim() === '') throw new ValidationError('Idempotency scope, key, and fingerprint are required');
    if (scope.length > 256 || key.length > 256 || fingerprint.length > 128) throw new ValidationError('Idempotency identifier exceeds allowed length');
    this.db.raw.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.get(scope, key);
      if (existing !== null) {
        if (existing.fingerprint !== fingerprint) throw new ConflictError('Idempotency key was reused with different input');
        this.db.raw.exec('COMMIT;');
        return { created: false, record: existing };
      }
      const now = new Date().toISOString();
      this.db.raw.prepare('INSERT INTO idempotency_keys(scope,idempotency_key,fingerprint,status,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(scope, key, fingerprint, 'IN_PROGRESS', null, now, now);
      const created = this.getRequired(scope, key);
      this.db.raw.exec('COMMIT;');
      return { created: true, record: created };
    } catch (error) {
      this.db.raw.exec('ROLLBACK;');
      throw error;
    }
  }

  public complete(scope: string, key: string, result: unknown): IdempotencyRecord { return this.finish(scope, key, 'COMPLETED', result); }
  public fail(scope: string, key: string, result: unknown): IdempotencyRecord { return this.finish(scope, key, 'FAILED', result); }

  public get(scope: string, key: string): IdempotencyRecord | null {
    const row = this.db.raw.prepare('SELECT * FROM idempotency_keys WHERE scope=? AND idempotency_key=?').get(scope,key) as Row|undefined;
    return row === undefined ? null : map(row);
  }

  public requireReplayable(scope: string, key: string, fingerprint: string): IdempotencyRecord | null {
    const record = this.get(scope, key);
    if (record === null) return null;
    if (record.fingerprint !== fingerprint) throw new ConflictError('Idempotency key was reused with different input');
    if (record.status === 'IN_PROGRESS') throw new ConflictError('Idempotent operation is still in progress');
    if (record.status === 'FAILED') throw new ConflictError('Previous idempotent operation failed; use a new key after reviewing the failure');
    return record;
  }

  private finish(scope:string,key:string,status:IdempotencyStatus,result:unknown):IdempotencyRecord {
    const current = this.getRequired(scope,key);
    if (current.status !== 'IN_PROGRESS' && current.status !== status) throw new ConflictError('Idempotency operation is already terminal');
    const serialized=JSON.stringify(redactValue(result))??'null';
    this.db.raw.prepare('UPDATE idempotency_keys SET status=?, result_json=?, updated_at=? WHERE scope=? AND idempotency_key=?')
      .run(status, serialized, new Date().toISOString(), scope, key);
    return this.getRequired(scope,key);
  }

  private getRequired(scope:string,key:string):IdempotencyRecord { const r=this.get(scope,key); if(r===null) throw new ConflictError('Idempotency key not found'); return r; }
}

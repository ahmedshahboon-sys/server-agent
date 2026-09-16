import type { SqliteDatabase } from '../database/sqlite.js';
import { ConflictError } from '../core/errors.js';

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

export class IdempotencyStore {
  public constructor(private readonly db: SqliteDatabase) {}
  public begin(scope: string, key: string, fingerprint: string): { readonly created: boolean; readonly record: IdempotencyRecord } {
    const existing = this.get(scope, key);
    if (existing !== null) {
      if (existing.fingerprint !== fingerprint) throw new ConflictError('Idempotency key was reused with different input');
      return { created: false, record: existing };
    }
    const now = new Date().toISOString();
    this.db.raw.prepare('INSERT INTO idempotency_keys(scope,idempotency_key,fingerprint,status,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(scope, key, fingerprint, 'IN_PROGRESS', null, now, now);
    return { created: true, record: this.getRequired(scope, key) };
  }
  public complete(scope: string, key: string, result: unknown): IdempotencyRecord { return this.finish(scope, key, 'COMPLETED', result); }
  public fail(scope: string, key: string, result: unknown): IdempotencyRecord { return this.finish(scope, key, 'FAILED', result); }
  public get(scope: string, key: string): IdempotencyRecord | null {
    const row = this.db.raw.prepare('SELECT * FROM idempotency_keys WHERE scope=? AND idempotency_key=?').get(scope,key) as Row|undefined;
    return row === undefined ? null : map(row);
  }
  private finish(scope:string,key:string,status:IdempotencyStatus,result:unknown):IdempotencyRecord {
    this.getRequired(scope,key);
    this.db.raw.prepare('UPDATE idempotency_keys SET status=?, result_json=?, updated_at=? WHERE scope=? AND idempotency_key=?')
      .run(status, JSON.stringify(result), new Date().toISOString(), scope, key);
    return this.getRequired(scope,key);
  }
  private getRequired(scope:string,key:string):IdempotencyRecord { const r=this.get(scope,key); if(r===null) throw new ConflictError('Idempotency key not found'); return r; }
}

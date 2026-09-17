import type { SqliteDatabase } from '../database/sqlite.js';
import { ConflictError, ValidationError } from '../core/errors.js';

export interface OperationLeaseRecord {
  readonly projectId: string;
  readonly operationType: string;
  readonly ownerId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

type LeasePayload = {
  readonly operationType: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
};

type Row = {
  readonly scope: string;
  readonly idempotency_key: string;
  readonly fingerprint: string;
  readonly status: string;
  readonly result_json: string | null;
};

const LEASE_SCOPE = 'operation-lease';

function parseLease(row: Row): OperationLeaseRecord | null {
  if (row.result_json === null) return null;
  const payload = JSON.parse(row.result_json) as Partial<LeasePayload>;
  if (typeof payload.operationType !== 'string' || typeof payload.acquiredAt !== 'string' || typeof payload.expiresAt !== 'string') return null;
  return {
    projectId: row.idempotency_key,
    operationType: payload.operationType,
    ownerId: row.fingerprint,
    acquiredAt: payload.acquiredAt,
    expiresAt: payload.expiresAt,
  };
}

export class OperationLeaseStore {
  public constructor(private readonly db: SqliteDatabase) {}

  public acquire(projectId: string, operationType: string, ownerId: string, ttlMs: number): OperationLeaseRecord {
    if (projectId.trim() === '' || operationType.trim() === '' || ownerId.trim() === '') throw new ValidationError('Lease identifiers are required');
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 86_400_000) throw new ValidationError('Lease TTL must be between 1 second and 24 hours');
    const now = Date.now();
    const acquiredAt = new Date(now).toISOString();
    const expiresAt = new Date(now + ttlMs).toISOString();
    this.db.raw.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.get(projectId);
      if (existing !== null && Date.parse(existing.expiresAt) > now && existing.ownerId !== ownerId) {
        throw new ConflictError(`Project already has an active ${existing.operationType} operation`);
      }
      const payload = JSON.stringify({ operationType, acquiredAt, expiresAt });
      const timestamp = acquiredAt;
      this.db.raw.prepare(`
        INSERT INTO idempotency_keys(scope,idempotency_key,fingerprint,status,result_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(scope,idempotency_key) DO UPDATE SET
          fingerprint=excluded.fingerprint,
          status='IN_PROGRESS',
          result_json=excluded.result_json,
          updated_at=excluded.updated_at
      `).run(LEASE_SCOPE, projectId, ownerId, 'IN_PROGRESS', payload, timestamp, timestamp);
      this.db.raw.exec('COMMIT;');
    } catch (error) {
      this.db.raw.exec('ROLLBACK;');
      throw error;
    }
    const lease = this.get(projectId);
    if (lease === null) throw new ConflictError('Operation lease was not persisted');
    return lease;
  }

  public renew(projectId: string, ownerId: string, ttlMs: number): OperationLeaseRecord {
    const existing = this.get(projectId);
    if (existing === null || existing.ownerId !== ownerId) throw new ConflictError('Operation lease is not owned by this runtime');
    return this.acquire(projectId, existing.operationType, ownerId, ttlMs);
  }

  public release(projectId: string, ownerId: string): boolean {
    const result = this.db.raw.prepare('DELETE FROM idempotency_keys WHERE scope=? AND idempotency_key=? AND fingerprint=?')
      .run(LEASE_SCOPE, projectId, ownerId);
    return Number(result.changes) > 0;
  }

  public get(projectId: string): OperationLeaseRecord | null {
    const row = this.db.raw.prepare('SELECT scope,idempotency_key,fingerprint,status,result_json FROM idempotency_keys WHERE scope=? AND idempotency_key=?')
      .get(LEASE_SCOPE, projectId) as Row | undefined;
    return row === undefined ? null : parseLease(row);
  }

  public reclaimExpired(now = new Date()): number {
    const rows = this.db.raw.prepare('SELECT scope,idempotency_key,fingerprint,status,result_json FROM idempotency_keys WHERE scope=?').all(LEASE_SCOPE) as Row[];
    let reclaimed = 0;
    for (const row of rows) {
      const lease = parseLease(row);
      if (lease === null || Date.parse(lease.expiresAt) <= now.getTime()) {
        const result = this.db.raw.prepare('DELETE FROM idempotency_keys WHERE scope=? AND idempotency_key=? AND fingerprint=?')
          .run(LEASE_SCOPE, row.idempotency_key, row.fingerprint);
        reclaimed += Number(result.changes);
      }
    }
    return reclaimed;
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { IdempotencyStore, idempotencyFingerprint } from '../../src/idempotency/idempotency.js';
import { OperationLeaseStore } from '../../src/operations/operation-lease.js';
import { ConflictError } from '../../src/core/errors.js';

test('idempotency returns same operation for same fingerprint and rejects reuse with different input', () => {
  const db=new SqliteDatabase(':memory:'); const store=new IdempotencyStore(db);
  try {
    const fingerprint=idempotencyFingerprint({b:2,a:1});
    assert.equal(fingerprint,idempotencyFingerprint({a:1,b:2}));
    assert.equal(store.begin('deploy','key-1',fingerprint).created,true);
    assert.equal(store.begin('deploy','key-1',fingerprint).created,false);
    assert.throws(()=>store.begin('deploy','key-1','different'),ConflictError);
    assert.equal(store.complete('deploy','key-1',{ok:true}).status,'COMPLETED');
    assert.deepEqual(store.requireReplayable('deploy','key-1',fingerprint)?.result,{ok:true});
  } finally { db.close(); }
});

test('failed idempotent operation cannot be silently replayed', () => {
  const db=new SqliteDatabase(':memory:'); const store=new IdempotencyStore(db);
  try { store.begin('write','key-fail','abc'); store.fail('write','key-fail',{reason:'failed'}); assert.throws(()=>store.requireReplayable('write','key-fail','abc'),ConflictError); }
  finally { db.close(); }
});

test('operation leases serialize project mutations and reclaim only expired leases', () => {
  const db=new SqliteDatabase(':memory:'); const leases=new OperationLeaseStore(db);
  try {
    const first=leases.acquire('project-a','deploy','owner-a',5_000);assert.equal(first.ownerId,'owner-a');
    assert.throws(()=>leases.acquire('project-a','rollback','owner-b',5_000),ConflictError);
    assert.equal(leases.release('project-a','wrong-owner'),false);
    assert.equal(leases.release('project-a','owner-a'),true);
    const expired=leases.acquire('project-a','write','owner-c',1_000);
    assert.equal(leases.reclaimExpired(new Date(Date.parse(expired.expiresAt)+1)),1);
    assert.equal(leases.get('project-a'),null);
  } finally { db.close(); }
});

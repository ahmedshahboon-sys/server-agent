import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { IdempotencyStore } from '../../src/idempotency/idempotency.js';
import { ConflictError } from '../../src/core/errors.js';

test('idempotency returns same operation for same fingerprint and rejects reuse with different input', () => {
  const db=new SqliteDatabase(':memory:'); const store=new IdempotencyStore(db);
  try { assert.equal(store.begin('deploy','key-1','abc').created,true); assert.equal(store.begin('deploy','key-1','abc').created,false); assert.throws(()=>store.begin('deploy','key-1','different'),ConflictError); assert.equal(store.complete('deploy','key-1',{ok:true}).status,'COMPLETED'); }
  finally { db.close(); }
});

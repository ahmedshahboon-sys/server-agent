import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { DatabaseService, ProjectDatabaseAdapterFactory } from '../../src/database/database-service.js';
import { AuthorizationError, DestructiveOperationError } from '../../src/core/errors.js';
import { projectFixture, tempDir } from '../helpers.js';

const readPrincipal={id:'reader',kind:'local' as const,projectScopes:['project-a'],permissions:['database:read'] as const};
const writePrincipal={id:'writer',kind:'local' as const,projectScopes:['project-a'],permissions:['database:read','database:write'] as const};

async function setup(defaultAccess:'read'|'controlled-write'='controlled-write') {
  const temp=await tempDir('server-agent-db-'); await mkdir(path.join(temp.path,'data'));
  const appPath=path.join(temp.path,'data','app.sqlite'); const app=new DatabaseSync(appPath);
  app.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO items(name) VALUES (\'one\'),(\'two\'); CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations(version) VALUES (7);'); app.close();
  const state=new SqliteDatabase(':memory:'); const registry=new ProjectRegistry(state);
  registry.create(projectFixture({root:temp.path,database:{adapter:'sqlite',defaultAccess,metadata:{path:'data/app.sqlite'}},permissions:['database:read','database:write'],health:{type:'none'},deployment:{strategy:'none',requireClean:true,validationRequired:false,restartService:false,healthRequired:false}}));
  const service=new DatabaseService(state,registry,new DefaultDenyAuthorizer(),new ProjectDatabaseAdapterFactory(),{timeoutMs:1000,maxRows:1,maxResultBytes:4096});
  return {temp,state,service,appPath};
}

test('database service reads with row bounds and reports schema/migration status', async()=>{
  const {temp,state,service}=await setup();
  try{
    const result=await service.query('project-a',readPrincipal,'SELECT id,name FROM items ORDER BY id');
    assert.equal(result.classification,'READ'); assert.equal(result.rows.length,1); assert.equal(result.truncated,true);
    const schema=await service.schema('project-a',readPrincipal); assert.ok(schema.objects.some((row)=>row['name']==='items'));
    const migration=await service.migrationStatus('project-a',readPrincipal); assert.equal(migration.known,true); assert.equal(migration.current,'7');
  } finally {state.close();await temp.cleanup();}
});

test('sqlite read limits stop iteration before a huge result is materialized', async()=>{
  const { SqliteProjectAdapter } = await import('../../src/database/sqlite-adapter.js');
  const temp=await tempDir('server-agent-db-stream-');const appPath=path.join(temp.path,'stream.sqlite');const app=new DatabaseSync(appPath);app.exec('CREATE TABLE x(id INTEGER);');app.close();
  const adapter=new SqliteProjectAdapter(appPath);
  try{
    const result=await adapter.query({sql:'WITH RECURSIVE cnt(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM cnt WHERE x<5000000) SELECT x FROM cnt',classification:'READ',timeoutMs:500,maxRows:1,maxBytes:1024});
    assert.equal(result.rows.length,1);
    assert.equal(result.rows[0]?.['x'],0);
    assert.equal(result.truncated,true);
  } finally {await adapter.close();await temp.cleanup();}
});

test('database service gates writes and blocks destructive statements', async()=>{
  const {temp,state,service}=await setup();
  try{
    await assert.rejects(service.query('project-a',readPrincipal,"INSERT INTO items(name) VALUES ('three')"),AuthorizationError);
    const write=await service.query('project-a',writePrincipal,"INSERT INTO items(name) VALUES ('three')"); assert.equal(write.changedRows,1);
    await assert.rejects(service.query('project-a',writePrincipal,'DELETE FROM items'),DestructiveOperationError);
    await assert.rejects(service.query('project-a',writePrincipal,'DROP TABLE items'),DestructiveOperationError);
  } finally {state.close();await temp.cleanup();}
});

test('database transaction rolls back atomically on failure and audit stores hashes only', async()=>{
  const {temp,state,service}=await setup();
  try{
    await assert.rejects(service.transaction('project-a',writePrincipal,[{sql:"INSERT INTO items(name) VALUES ('three')"},{sql:"INSERT INTO missing(name) VALUES ('boom')"}]));
    const count=await service.query('project-a',readPrincipal,'SELECT COUNT(*) AS n FROM items'); assert.equal(count.rows[0]?.['n'],2);
    const audit=state.raw.prepare('SELECT statement_hash FROM database_audit').all() as {statement_hash:string}[]; assert.ok(audit.length>=2); assert.ok(audit.every((row)=>/^[a-f0-9]{64}$/.test(row.statement_hash)));
  } finally {state.close();await temp.cleanup();}
});

test('project configured read-only rejects controlled writes even for authorized principal', async()=>{
  const {temp,state,service}=await setup('read');
  try{await assert.rejects(service.query('project-a',writePrincipal,"UPDATE items SET name='x' WHERE id=1"),AuthorizationError);}finally{state.close();await temp.cleanup();}
});

test('sqlite adapter enforces hard query timeout in a worker', async()=>{
  const { SqliteProjectAdapter } = await import('../../src/database/sqlite-adapter.js');
  const temp=await tempDir('server-agent-db-timeout-');const appPath=path.join(temp.path,'slow.sqlite');const app=new DatabaseSync(appPath);app.exec('CREATE TABLE x(id INTEGER);');app.close();
  const adapter=new SqliteProjectAdapter(appPath);
  try{
    await assert.rejects(adapter.query({sql:'WITH RECURSIVE cnt(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM cnt WHERE x<100000000) SELECT sum(x) AS total FROM cnt',classification:'READ',timeoutMs:30,maxRows:1,maxBytes:1024}), (error:unknown)=>error instanceof Error && (error as {code?:string}).code==='DATABASE_TIMEOUT');
  } finally {await adapter.close();await temp.cleanup();}
});

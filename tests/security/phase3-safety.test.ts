import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { HealthCheckService, type HttpProbe } from '../../src/health/health-service.js';
import type { DatabaseAdapterFactory } from '../../src/database/database-service.js';
import type { ServiceController, ServiceSnapshot } from '../../src/services/service-controller.js';
import { classifySql, assertNonDestructiveSql } from '../../src/database/sql-safety.js';
import { DestructiveOperationError } from '../../src/core/errors.js';
import { projectFixture } from '../helpers.js';

class FakeService implements ServiceController { public async status():Promise<ServiceSnapshot>{return{active:true,state:'active',details:{}};} public async restart():Promise<void>{} }
const databases:DatabaseAdapterFactory={async create(){throw new Error('not used');}};

test('phase 3 SQL safety blocks destructive queries',()=>{
  assert.equal(classifySql('DELETE FROM users').classification,'DESTRUCTIVE');
  assert.throws(()=>assertNonDestructiveSql('DROP TABLE users'),DestructiveOperationError);
  assert.throws(()=>assertNonDestructiveSql('TRUNCATE users'),DestructiveOperationError);
});

test('HTTP health checks do not call private literal targets',async()=>{
  const db=new SqliteDatabase(':memory:');const registry=new ProjectRegistry(db);let called=false;
  const http:HttpProbe={async check(){called=true;return{ok:true,statusCode:200,latencyMs:1};}};
  registry.create(projectFixture({domain:'127.0.0.1',permissions:['health:read'],health:{type:'http',path:'/health'},database:{adapter:'none',defaultAccess:'read'},deployment:{strategy:'none',requireClean:true,validationRequired:false,restartService:false,healthRequired:false}}));
  const principal={id:'health',kind:'local' as const,projectScopes:['project-a'],permissions:['health:read'] as const};
  try{const result=await new HealthCheckService(db,registry,new DefaultDenyAuthorizer(),new FakeService(),http,databases).check('project-a',principal);assert.equal(called,false);assert.equal(result.state,'UNKNOWN');}finally{db.close();}
});

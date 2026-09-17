import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { IdempotencyStore } from '../../src/idempotency/idempotency.js';
import { withIdempotencyKey } from '../../src/idempotency/context.js';
import { OperationLeaseStore } from '../../src/operations/operation-lease.js';
import { ProjectServiceManager, type ServiceController, type ServiceSnapshot } from '../../src/services/service-controller.js';
import { ConflictError } from '../../src/core/errors.js';
import { projectFixture } from '../helpers.js';

const principal={id:'operator',kind:'local' as const,projectScopes:['project-a'],permissions:['service:read','service:restart'] as const};

class FakeController implements ServiceController {
  public restarts=0;
  public async status(_serviceName:string):Promise<ServiceSnapshot>{return{active:true,state:'active',details:{}};}
  public async restart(_serviceName:string):Promise<void>{this.restarts+=1;}
}

test('service restart replays safely for the same idempotency key',async()=>{
  const db=new SqliteDatabase(':memory:');const projects=new ProjectRegistry(db);projects.create(projectFixture({serviceName:'project-a.service',permissions:['service:read','service:restart']}));
  const controller=new FakeController(),idempotency=new IdempotencyStore(db),leases=new OperationLeaseStore(db);const services=new ProjectServiceManager(projects,new DefaultDenyAuthorizer(),controller,{idempotency,leases,ownerId:'runtime-test'});
  try{await withIdempotencyKey('restart-1',()=>services.restart('project-a',principal));await withIdempotencyKey('restart-1',()=>services.restart('project-a',principal));assert.equal(controller.restarts,1);}
  finally{db.close();}
});

test('service restart refuses to overlap another project mutation lease',async()=>{
  const db=new SqliteDatabase(':memory:');const projects=new ProjectRegistry(db);projects.create(projectFixture({serviceName:'project-a.service',permissions:['service:read','service:restart']}));
  const controller=new FakeController(),idempotency=new IdempotencyStore(db),leases=new OperationLeaseStore(db);const services=new ProjectServiceManager(projects,new DefaultDenyAuthorizer(),controller,{idempotency,leases,ownerId:'runtime-test'});
  try{leases.acquire('project-a','other-mutation','another-owner',5_000);await assert.rejects(withIdempotencyKey('restart-2',()=>services.restart('project-a',principal)),ConflictError);assert.equal(controller.restarts,0);}
  finally{db.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { HealthCheckService, type HttpProbe } from '../../src/health/health-service.js';
import type { DatabaseAdapterFactory } from '../../src/database/database-service.js';
import type { ServiceController, ServiceSnapshot } from '../../src/services/service-controller.js';
import { projectFixture } from '../helpers.js';

const principal={id:'health',kind:'local' as const,projectScopes:['project-a'],permissions:['health:read'] as const};
class FakeService implements ServiceController { public constructor(private readonly active:boolean){} public async status():Promise<ServiceSnapshot>{return{active:this.active,state:this.active?'active':'failed',details:{}};} public async restart():Promise<void>{} }
const http:HttpProbe={async check(){return{ok:true,statusCode:200,latencyMs:1};}};
const databases:DatabaseAdapterFactory={async create(){throw new Error('not used');}};

function setup(active:boolean){const db=new SqliteDatabase(':memory:');const registry=new ProjectRegistry(db);registry.create(projectFixture({permissions:['health:read'],health:{type:'service'},database:{adapter:'none',defaultAccess:'read'},deployment:{strategy:'none',requireClean:true,validationRequired:false,restartService:false,healthRequired:false}}));return{db,health:new HealthCheckService(db,registry,new DefaultDenyAuthorizer(),new FakeService(active),http,databases)};}

test('health service reports HEALTHY for active service',async()=>{const {db,health}=setup(true);try{const result=await health.check('project-a',principal);assert.equal(result.state,'HEALTHY');assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM health_checks').get() as {n:number}).n,1);}finally{db.close();}});
test('health service reports UNHEALTHY for failed service',async()=>{const {db,health}=setup(false);try{const result=await health.check('project-a',principal);assert.equal(result.state,'UNHEALTHY');}finally{db.close();}});

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { RestrictedCommandRunner } from '../../src/commands/command-runner.js';
import { GitService } from '../../src/git/git-service.js';
import { LocalValidationPipeline } from '../../src/validation/local-ci.js';
import { TaskEngine } from '../../src/tasks/task-engine.js';
import { HealthCheckService, type HttpProbe } from '../../src/health/health-service.js';
import { DeploymentEngine } from '../../src/deployment/deployment-engine.js';
import type { DatabaseAdapterFactory } from '../../src/database/database-service.js';
import type { ServiceController, ServiceSnapshot } from '../../src/services/service-controller.js';
import { projectFixture, tempDir } from '../helpers.js';

const principal={id:'deployer',kind:'remote' as const,projectScopes:['project-a'],permissions:['deploy:run'] as const};
class FakeService implements ServiceController { public restarts=0; public constructor(private readonly active:boolean){} public async status():Promise<ServiceSnapshot>{return{active:this.active,state:this.active?'active':'failed',details:{}};} public async restart():Promise<void>{this.restarts+=1;} }
const http:HttpProbe={async check(){return{ok:true,statusCode:200,latencyMs:1};}};
const databases:DatabaseAdapterFactory={async create(){throw new Error('database should not be used');}};

async function setup(active:boolean){
  const temp=await tempDir('server-agent-deploy-'); execFileSync('git',['init','-b','main'],{cwd:temp.path}); execFileSync('git',['config','user.email','test@example.test'],{cwd:temp.path}); execFileSync('git',['config','user.name','Test'],{cwd:temp.path}); await writeFile(path.join(temp.path,'README.md'),'ok\n'); execFileSync('git',['add','README.md'],{cwd:temp.path}); execFileSync('git',['commit','-m','initial'],{cwd:temp.path});
  const db=new SqliteDatabase(':memory:');const registry=new ProjectRegistry(db);
  registry.create(projectFixture({root:temp.path,permissions:['deploy:run','git:read','commands:run','health:read'],commands:{test:['node','-e','process.exit(0)'],build:['node','-e','process.exit(0)'],deploy:['node','-e','process.exit(0)']},health:{type:'service'},database:{adapter:'none',defaultAccess:'read'},deployment:{strategy:'command',branch:'main',requireClean:true,validationRequired:true,restartService:false,healthRequired:true}}));
  const auth=new DefaultDenyAuthorizer();const runner=new RestrictedCommandRunner(registry,auth,{timeoutMs:2000,maxOutputBytes:4096});const git=new GitService(registry,auth,{timeoutMs:2000,maxOutputBytes:4096});const tasks=new TaskEngine(db);const validation=new LocalValidationPipeline(db,registry,runner,3);const services=new FakeService(active);const health=new HealthCheckService(db,registry,auth,services,http,databases);const engine=new DeploymentEngine(db,registry,auth,git,runner,validation,tasks,health,services,databases);const task=tasks.create('project-a','Deploy');
  return{temp,db,tasks,engine,task};
}

test('deployment succeeds only after validation and healthy post-check',async()=>{const {temp,db,tasks,engine,task}=await setup(true);try{const result=await engine.deploy(task.taskId,'project-a',principal);assert.equal(result.status,'SUCCEEDED');assert.equal(result.healthCheck?.state,'HEALTHY');assert.equal(result.rollbackAvailable,true);assert.equal(tasks.get(task.taskId)?.status,'COMPLETED');}finally{db.close();await temp.cleanup();}});

test('failed post-deploy health marks deployment and task failed',async()=>{const {temp,db,tasks,engine,task}=await setup(false);try{const result=await engine.deploy(task.taskId,'project-a',principal);assert.equal(result.status,'FAILED');assert.equal(result.healthCheck?.state,'UNHEALTHY');assert.equal(tasks.get(task.taskId)?.status,'FAILED');assert.equal(result.rollbackAvailable,true);}finally{db.close();await temp.cleanup();}});

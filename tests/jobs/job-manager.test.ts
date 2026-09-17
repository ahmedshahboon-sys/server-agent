import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { RestrictedCommandRunner } from '../../src/commands/command-runner.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { TaskEngine } from '../../src/tasks/task-engine.js';
import { IdempotencyStore } from '../../src/idempotency/idempotency.js';
import { OperationLeaseStore } from '../../src/operations/operation-lease.js';
import { ConflictError } from '../../src/core/errors.js';
import { projectFixture, tempDir } from '../helpers.js';

const principal={id:'tester',kind:'local' as const,projectScopes:['project-a'],permissions:['commands:run'] as const};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

async function waitForTerminal(jobs:JobManager,jobId:string){let current=jobs.get(jobId);for(let i=0;i<100&&current?.status==='RUNNING';i++){await sleep(20);current=jobs.get(jobId);}return current;}

test('job manager persists command lifecycle and output locations', async()=>{
  const temp=await tempDir('server-agent-job-');const db=new SqliteDatabase(':memory:');const registry=new ProjectRegistry(db);
  registry.create(projectFixture({root:temp.path,permissions:['commands:run'],commands:{allowed:{ok:['node','-e','process.stdout.write("done\\n")']}}}));
  const runner=new RestrictedCommandRunner(registry,new DefaultDenyAuthorizer(),{timeoutMs:1000,maxOutputBytes:1024});const jobs=new JobManager(db,runner,temp.path,1);
  try{const job=await jobs.start('project-a',principal,'ok');const current=await waitForTerminal(jobs,job.jobId);assert.equal(current?.status,'COMPLETED');assert.equal(current?.exitCode,0);assert.ok(current?.stdoutPath.endsWith('stdout.log'));assert.match(await fs.readFile(current!.stdoutPath,'utf8'),/done/);}
  finally{await jobs.shutdown();db.close();await temp.cleanup();}
});

test('job output is streamed while running and secrets are redacted before disk write', async()=>{
  const temp=await tempDir('server-agent-job-stream-');const db=new SqliteDatabase(':memory:');const registry=new ProjectRegistry(db);
  registry.create(projectFixture({root:temp.path,permissions:['commands:run'],environmentRefs:['PROJECT_SECRET'],commands:{allowed:{stream:['node','-e','process.stdout.write(process.env.PROJECT_SECRET+"\\n");setTimeout(()=>process.stdout.write("later\\n"),500);setTimeout(()=>process.exit(0),900)']}}}));
  const runner=new RestrictedCommandRunner(registry,new DefaultDenyAuthorizer(),{timeoutMs:3000,maxOutputBytes:4096,environment:{...process.env,PROJECT_SECRET:'very-secret-value'}});const jobs=new JobManager(db,runner,temp.path,1);
  try{const job=await jobs.start('project-a',principal,'stream');await sleep(200);assert.equal(jobs.get(job.jobId)?.status,'RUNNING');const partial=await fs.readFile(job.stdoutPath,'utf8');assert.match(partial,/\[REDACTED\]/);assert.equal(partial.includes('very-secret-value'),false);await waitForTerminal(jobs,job.jobId);}
  finally{await jobs.shutdown();db.close();await temp.cleanup();}
});

test('idempotent job start returns the same durable job and project lease blocks overlap', async()=>{
  const temp=await tempDir('server-agent-job-idem-');const db=new SqliteDatabase(':memory:');const registry=new ProjectRegistry(db);
  registry.create(projectFixture({root:temp.path,permissions:['commands:run'],commands:{allowed:{slow:['node','-e','setTimeout(()=>{},500)']}}}));
  const runner=new RestrictedCommandRunner(registry,new DefaultDenyAuthorizer(),{timeoutMs:2000,maxOutputBytes:1024});const idempotency=new IdempotencyStore(db),leases=new OperationLeaseStore(db);const jobs=new JobManager(db,runner,temp.path,2,{idempotency,leases,leaseTtlMs:3000});
  try{const first=await jobs.start('project-a',principal,'slow',undefined,'request-1');const replay=await jobs.start('project-a',principal,'slow',undefined,'request-1');assert.equal(replay.jobId,first.jobId);await assert.rejects(jobs.start('project-a',principal,'slow',undefined,'request-2'),ConflictError);assert.equal(jobs.list('project-a').length,1);await jobs.shutdown();}
  finally{db.close();await temp.cleanup();}
});

test('restart reconciliation never trusts an inherited or reused PID', async()=>{
  const temp=await tempDir('server-agent-job-');const db=new SqliteDatabase(':memory:');const registry=new ProjectRegistry(db);registry.create(projectFixture({root:temp.path}));
  const runner=new RestrictedCommandRunner(registry,new DefaultDenyAuthorizer(),{timeoutMs:1000,maxOutputBytes:1024});const jobs=new JobManager(db,runner,temp.path,1);
  try{const now=new Date().toISOString();db.raw.prepare('INSERT INTO jobs(job_id,task_id,project_id,command_id,pid,started_at,finished_at,status,exit_code,stdout_path,stderr_path,error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('orphan',null,'project-a','x',process.pid,now,null,'RUNNING',null,'/tmp/a','/tmp/b',null);assert.equal(jobs.reconcileAfterRestart(),1);assert.equal(jobs.get('orphan')?.status,'UNKNOWN');}
  finally{await jobs.shutdown();db.close();await temp.cleanup();}
});

test('task cancellation stops the attached job before task becomes CANCELLED', async()=>{
  const temp=await tempDir('server-agent-job-task-');const db=new SqliteDatabase(':memory:');const registry=new ProjectRegistry(db);
  registry.create(projectFixture({root:temp.path,permissions:['commands:run'],commands:{allowed:{slow:['node','-e','setInterval(()=>{},1000)']}}}));
  const runner=new RestrictedCommandRunner(registry,new DefaultDenyAuthorizer(),{timeoutMs:10_000,maxOutputBytes:1024});const tasks=new TaskEngine(db);const jobs=new JobManager(db,runner,temp.path,1);tasks.bindJobController(jobs);
  try{const task=tasks.create('project-a','linked job');tasks.resume(task.taskId);const job=await jobs.start('project-a',principal,'slow',task.taskId);assert.throws(()=>tasks.pause(task.taskId),ConflictError);const cancelled=await tasks.cancel(task.taskId);assert.equal(cancelled.status,'CANCELLED');assert.equal(jobs.get(job.jobId)?.status,'CANCELLED');}
  finally{await jobs.shutdown();db.close();await temp.cleanup();}
});

test('job manager shutdown cancels attached work and waits for durable terminal state', async()=>{
  const temp=await tempDir('server-agent-job-');const db=new SqliteDatabase(':memory:');const registry=new ProjectRegistry(db);
  registry.create(projectFixture({root:temp.path,permissions:['commands:run'],commands:{allowed:{slow:['node','-e','setInterval(()=>{},1000)']}}}));
  const runner=new RestrictedCommandRunner(registry,new DefaultDenyAuthorizer(),{timeoutMs:10_000,maxOutputBytes:1024});const jobs=new JobManager(db,runner,temp.path,1);
  try{const job=await jobs.start('project-a',principal,'slow');assert.equal(jobs.get(job.jobId)?.status,'RUNNING');await jobs.shutdown();assert.equal(jobs.get(job.jobId)?.status,'CANCELLED');}
  finally{db.close();await temp.cleanup();}
});

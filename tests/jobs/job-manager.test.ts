import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { RestrictedCommandRunner } from '../../src/commands/command-runner.js';
import { JobManager } from '../../src/jobs/job-manager.js';
import { projectFixture, tempDir } from '../helpers.js';

const principal={id:'tester',kind:'local' as const,projectScopes:['project-a'],permissions:['commands:run'] as const};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test('job manager persists command lifecycle and output locations', async()=>{
  const temp=await tempDir('server-agent-job-');const db=new SqliteDatabase(':memory:');const registry=new ProjectRegistry(db);
  registry.create(projectFixture({root:temp.path,permissions:['commands:run'],commands:{allowed:{ok:['node','-e','process.stdout.write("done")']}}}));
  const runner=new RestrictedCommandRunner(registry,new DefaultDenyAuthorizer(),{timeoutMs:1000,maxOutputBytes:1024});const jobs=new JobManager(db,runner,temp.path,1);
  try{const job=await jobs.start('project-a',principal,'ok');let current=jobs.get(job.jobId);for(let i=0;i<50&&current?.status==='RUNNING';i++){await sleep(20);current=jobs.get(job.jobId);}assert.equal(current?.status,'COMPLETED');assert.equal(current?.exitCode,0);assert.ok(current?.stdoutPath.endsWith('stdout.log'));}
  finally{db.close();await temp.cleanup();}
});

test('restart reconciliation marks vanished running process UNKNOWN', async()=>{
  const temp=await tempDir('server-agent-job-');const db=new SqliteDatabase(':memory:');const registry=new ProjectRegistry(db);registry.create(projectFixture({root:temp.path}));
  const runner=new RestrictedCommandRunner(registry,new DefaultDenyAuthorizer(),{timeoutMs:1000,maxOutputBytes:1024});const jobs=new JobManager(db,runner,temp.path,1);
  try{const now=new Date().toISOString();db.raw.prepare('INSERT INTO jobs(job_id,task_id,project_id,command_id,pid,started_at,finished_at,status,exit_code,stdout_path,stderr_path,error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('orphan',null,'project-a','x',99999999,now,null,'RUNNING',null,'/tmp/a','/tmp/b',null);assert.equal(jobs.reconcileAfterRestart(),1);assert.equal(jobs.get('orphan')?.status,'UNKNOWN');}
  finally{db.close();await temp.cleanup();}
});

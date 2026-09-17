import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TaskEngine } from '../../src/tasks/task-engine.js';
import { IdempotencyStore } from '../../src/idempotency/idempotency.js';
import { OperationLeaseStore } from '../../src/operations/operation-lease.js';
import { PersistentOperationManager, type PersistentOperationResult } from '../../src/operations/persistent-operation.js';
import { ConflictError } from '../../src/core/errors.js';
import { projectFixture } from '../helpers.js';

function setup(){
  const db=new SqliteDatabase(':memory:');
  const projects=new ProjectRegistry(db);
  projects.create(projectFixture({health:{type:'none'},database:{adapter:'none',defaultAccess:'read'},deployment:{strategy:'none',requireClean:true,validationRequired:false,restartService:false,healthRequired:false},permissions:['project:read','tasks:read','tasks:write','commands:run'],environmentRefs:[]}));
  const tasks=new TaskEngine(db);
  const task=tasks.create('project-a','durable operation');
  const idempotency=new IdempotencyStore(db),leases=new OperationLeaseStore(db);
  return{db,tasks,task,idempotency,leases};
}

test('persistent operation returns immediately, replays by idempotency key, and serializes project work',async()=>{
  const {db,task,idempotency,leases}=setup();
  const manager=new PersistentOperationManager(db,idempotency,leases,'runtime-a',5_000);
  let finish!:(value:PersistentOperationResult)=>void;
  const gate=new Promise<PersistentOperationResult>((resolve)=>{finish=resolve;});
  try{
    const first=manager.start('VALIDATION','project-a',task.taskId,async()=>gate,'request-1');
    assert.equal(first.status,'RUNNING');
    const replay=manager.start('VALIDATION','project-a',task.taskId,async()=>({result:{unexpected:true}}),'request-1');
    assert.equal(replay.operationId,first.operationId);
    assert.throws(()=>manager.start('DEPLOYMENT','project-a',task.taskId,async()=>({result:{ok:true}}),'request-2'),ConflictError);
    finish({targetId:'validation-1',result:{ok:true}});
    await manager.shutdown();
    const completed=manager.get(first.operationId);
    assert.equal(completed?.status,'SUCCEEDED');
    assert.equal(completed?.targetId,'validation-1');
    assert.deepEqual(completed?.result,{ok:true});
  }finally{db.close();}
});

test('restart reconciliation marks running operations UNKNOWN and blocks blind task resume',()=>{
  const {db,tasks,task,idempotency,leases}=setup();
  const manager=new PersistentOperationManager(db,idempotency,leases,'runtime-b',5_000);
  const now=new Date().toISOString();
  try{
    db.raw.prepare('INSERT INTO persistent_operations(operation_id,task_id,project_id,operation_type,status,target_id,created_at,started_at,finished_at,result_json,error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('operation-old',task.taskId,'project-a','DEPLOYMENT','RUNNING',null,now,now,null,null,null);
    assert.equal(manager.reconcileAfterRestart(),1);
    assert.equal(manager.get('operation-old')?.status,'UNKNOWN');
    assert.equal(tasks.markUnknownWorkForRecovery(),1);
    assert.equal(tasks.get(task.taskId)?.status,'RECOVERY_REQUIRED');
    assert.throws(()=>tasks.resume(task.taskId),ConflictError);
  }finally{db.close();}
});

test('RECOVERY_REQUIRED task resumes only after a persisted RESUME_RECOMMENDED decision',()=>{
  const {db,tasks,task}=setup();
  const now=new Date().toISOString();
  try{
    tasks.setStatus(task.taskId,'RECOVERY_REQUIRED');
    assert.throws(()=>tasks.resume(task.taskId),ConflictError);
    db.raw.prepare('INSERT INTO recovery_runs(recovery_id,task_id,project_id,deployment_id,attempt,status,reason,evidence_json,decision_json,started_at,finished_at,error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('recovery-ok',task.taskId,'project-a',null,1,'RESUME_RECOMMENDED','verified','{}',JSON.stringify({action:'RESUME_RECOMMENDED',reason:'verified',lastConfirmedState:{}}),now,now,null);
    assert.equal(tasks.resume(task.taskId).status,'RUNNING');
  }finally{db.close();}
});

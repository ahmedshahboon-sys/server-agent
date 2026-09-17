import { randomUUID } from 'node:crypto';
import { closeSync, openSync, promises as fs, writeSync } from 'node:fs';
import path from 'node:path';
import type { SqliteDatabase } from '../database/sqlite.js';
import type { Principal, JobStatus } from '../core/types.js';
import { ConflictError, ValidationError } from '../core/errors.js';
import { RestrictedCommandRunner } from '../commands/command-runner.js';
import { redactError, redactValue } from '../security/redaction.js';
import { currentIdempotencyKey } from '../idempotency/context.js';
import { IdempotencyStore, idempotencyFingerprint } from '../idempotency/idempotency.js';
import { OperationLeaseStore } from '../operations/operation-lease.js';

export interface JobRecord { readonly jobId:string; readonly taskId:string|null; readonly projectId:string; readonly commandId:string; readonly pid:number|null; readonly startedAt:string|null; readonly finishedAt:string|null; readonly status:JobStatus; readonly exitCode:number|null; readonly stdoutPath:string; readonly stderrPath:string; readonly error:unknown; }
type Row={job_id:string;task_id:string|null;project_id:string;command_id:string;pid:number|null;started_at:string|null;finished_at:string|null;status:JobStatus;exit_code:number|null;stdout_path:string;stderr_path:string;error_json:string|null};
function map(r:Row):JobRecord{return{jobId:r.job_id,taskId:r.task_id,projectId:r.project_id,commandId:r.command_id,pid:r.pid,startedAt:r.started_at,finishedAt:r.finished_at,status:r.status,exitCode:r.exit_code,stdoutPath:r.stdout_path,stderrPath:r.stderr_path,error:r.error_json===null?null:JSON.parse(r.error_json)};}

export interface JobManagerOptions {
  readonly instanceId?: string;
  readonly idempotency?: IdempotencyStore;
  readonly leases?: OperationLeaseStore;
  readonly leaseTtlMs?: number;
}

export class JobManager {
  private readonly controllers=new Map<string,AbortController>();
  private readonly active=new Map<string,Promise<void>>();
  private readonly instanceId:string;
  private readonly idempotency?:IdempotencyStore;
  private readonly leases?:OperationLeaseStore;
  private readonly leaseTtlMs:number;

  public constructor(private readonly db:SqliteDatabase,private readonly runner:RestrictedCommandRunner,private readonly outputDir:string,private readonly maxConcurrentJobs=1,options:JobManagerOptions={}){
    this.instanceId=options.instanceId??randomUUID();
    this.idempotency=options.idempotency;
    this.leases=options.leases;
    this.leaseTtlMs=options.leaseTtlMs??600_000;
  }

  public async start(projectId:string,principal:Principal,commandId:string,taskId?:string,idempotencyKey?:string):Promise<JobRecord>{
    const effectiveKey=idempotencyKey??currentIdempotencyKey();
    const scope=`job-start:${projectId}`;
    const fingerprint=idempotencyFingerprint({projectId,commandId,taskId:taskId??null});
    if(effectiveKey!==undefined&&this.idempotency!==undefined){
      const replay=this.idempotency.requireReplayable(scope,effectiveKey,fingerprint);
      if(replay!==null){
        const jobId=(replay.result as {jobId?:unknown}|null)?.jobId;
        if(typeof jobId!=='string')throw new ConflictError('Stored idempotent job result is invalid');
        return this.getRequired(jobId);
      }
      this.idempotency.begin(scope,effectiveKey,fingerprint);
    }

    const id=randomUUID(),dir=path.join(this.outputDir,'jobs',id),stdoutPath=path.join(dir,'stdout.log'),stderrPath=path.join(dir,'stderr.log');
    const leaseOwner=`${this.instanceId}:${id}`;
    let leaseHeld=false;
    let stdoutFd:number|undefined;
    let stderrFd:number|undefined;
    try{
      if(this.leases!==undefined){this.leases.acquire(projectId,`command:${commandId}`,leaseOwner,this.leaseTtlMs);leaseHeld=true;}
      await fs.mkdir(dir,{recursive:true,mode:0o750});
      stdoutFd=openSync(stdoutPath,'a',0o640);stderrFd=openSync(stderrPath,'a',0o640);
      const now=new Date().toISOString();
      this.db.raw.exec('BEGIN IMMEDIATE;');
      try{
        const running=(this.db.raw.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='RUNNING'").get() as {n:number}).n;
        if(running>=this.maxConcurrentJobs)throw new ConflictError('Concurrent job limit reached');
        if(taskId!==undefined){
          const task=this.db.raw.prepare('SELECT project_id,status FROM tasks WHERE task_id=?').get(taskId) as {project_id:string;status:string}|undefined;
          if(task===undefined||task.project_id!==projectId)throw new ValidationError('Task is not available for this project');
          if(task.status!=='RUNNING')throw new ConflictError('Task must be RUNNING before attaching a job');
          const attached=this.db.raw.prepare("SELECT job_id FROM jobs WHERE task_id=? AND status='RUNNING' LIMIT 1").get(taskId);
          if(attached!==undefined)throw new ConflictError('Task already has a running job');
        }
        this.db.raw.prepare('INSERT INTO jobs(job_id,task_id,project_id,command_id,pid,started_at,finished_at,status,exit_code,stdout_path,stderr_path,error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,taskId??null,projectId,commandId,null,now,null,'RUNNING',null,stdoutPath,stderrPath,null);
        this.db.raw.exec('COMMIT;');
      }catch(error){this.db.raw.exec('ROLLBACK;');throw error;}

      const controller=new AbortController();this.controllers.set(id,controller);
      const outFd=stdoutFd,errFd=stderrFd;
      const execution=this.runner.run(projectId,principal,commandId,{
        signal:controller.signal,
        onSpawn:(pid)=>this.db.raw.prepare('UPDATE jobs SET pid=? WHERE job_id=?').run(pid??null,id),
        onStdout:(chunk)=>{if(outFd!==undefined)writeSync(outFd,chunk);},
        onStderr:(chunk)=>{if(errFd!==undefined)writeSync(errFd,chunk);},
      })
        .then(result=>{const status:JobStatus=controller.signal.aborted?'CANCELLED':result.exitCode===0?'COMPLETED':'FAILED';this.db.raw.prepare('UPDATE jobs SET status=?,exit_code=?,finished_at=? WHERE job_id=?').run(status,result.exitCode,new Date().toISOString(),id);if(taskId!==undefined)this.appendTaskCommand(taskId,{jobId:id,commandId,status,exitCode:result.exitCode});})
        .catch(error=>{const safe=redactError(error);try{if(errFd!==undefined)writeSync(errFd,`${JSON.stringify(safe)}\n`);}catch{}const status:JobStatus=controller.signal.aborted?'CANCELLED':'FAILED';this.db.raw.prepare('UPDATE jobs SET status=?,finished_at=?,error_json=? WHERE job_id=?').run(status,new Date().toISOString(),JSON.stringify(safe),id);if(taskId!==undefined)this.appendTaskCommand(taskId,{jobId:id,commandId,status,error:safe});})
        .finally(()=>{try{if(outFd!==undefined)closeSync(outFd);}catch{}try{if(errFd!==undefined)closeSync(errFd);}catch{}this.controllers.delete(id);this.active.delete(id);if(leaseHeld)this.leases?.release(projectId,leaseOwner);});
      this.active.set(id,execution);
      if(effectiveKey!==undefined&&this.idempotency!==undefined)this.idempotency.complete(scope,effectiveKey,{jobId:id});
      return this.getRequired(id);
    }catch(error){
      try{if(stdoutFd!==undefined)closeSync(stdoutFd);}catch{}try{if(stderrFd!==undefined)closeSync(stderrFd);}catch{}
      if(leaseHeld)this.leases?.release(projectId,leaseOwner);
      if(effectiveKey!==undefined&&this.idempotency!==undefined){const record=this.idempotency.get(scope,effectiveKey);if(record?.status==='IN_PROGRESS')this.idempotency.fail(scope,effectiveKey,redactError(error));}
      throw error;
    }
  }

  public get(jobId:string):JobRecord|null{const r=this.db.raw.prepare('SELECT * FROM jobs WHERE job_id=?').get(jobId) as Row|undefined;return r===undefined?null:map(r);}
  public list(projectId?:string):readonly JobRecord[]{const rows=(projectId===undefined?this.db.raw.prepare('SELECT * FROM jobs ORDER BY started_at DESC').all():this.db.raw.prepare('SELECT * FROM jobs WHERE project_id=? ORDER BY started_at DESC').all(projectId)) as Row[];return rows.map(map);}
  public activeForTask(taskId:string):JobRecord|null{const row=this.db.raw.prepare("SELECT * FROM jobs WHERE task_id=? AND status='RUNNING' ORDER BY started_at DESC LIMIT 1").get(taskId) as Row|undefined;return row===undefined?null:map(row);}

  public cancel(jobId:string):JobRecord{const job=this.getRequired(jobId);if(job.status!=='RUNNING')throw new ConflictError('Only running jobs can be cancelled');const controller=this.controllers.get(jobId);if(controller===undefined)throw new ConflictError('Running job is not attached to this Agent process');controller.abort();return this.getRequired(jobId);}
  public async cancelAndWait(jobId:string):Promise<JobRecord>{this.cancel(jobId);const execution=this.active.get(jobId);if(execution!==undefined)await execution;return this.getRequired(jobId);}

  public reconcileAfterRestart():number{
    const now=new Date().toISOString();
    const result=this.db.raw.prepare("UPDATE jobs SET status='UNKNOWN',finished_at=? WHERE status='RUNNING'").run(now);
    return Number(result.changes);
  }

  public async shutdown():Promise<void>{for(const controller of this.controllers.values())controller.abort();await Promise.allSettled([...this.active.values()]);}
  private appendTaskCommand(taskId:string,value:unknown):void{this.db.raw.exec('BEGIN IMMEDIATE;');try{const row=this.db.raw.prepare('SELECT commands_executed_json FROM tasks WHERE task_id=?').get(taskId) as {commands_executed_json:string}|undefined;if(row===undefined){this.db.raw.exec('COMMIT;');return;}const items=JSON.parse(row.commands_executed_json) as unknown[];items.push(redactValue(value));this.db.raw.prepare('UPDATE tasks SET commands_executed_json=?,updated_at=? WHERE task_id=?').run(JSON.stringify(items),new Date().toISOString(),taskId);this.db.raw.exec('COMMIT;');}catch(error){this.db.raw.exec('ROLLBACK;');throw error;}}
  private getRequired(id:string):JobRecord{const j=this.get(id);if(j===null)throw new ValidationError('Job not found');return j;}
}

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SqliteDatabase } from '../database/sqlite.js';
import type { Principal, JobStatus } from '../core/types.js';
import { ConflictError, ValidationError } from '../core/errors.js';
import { RestrictedCommandRunner } from '../commands/command-runner.js';
import { redactError, redactValue } from '../security/redaction.js';

export interface JobRecord { readonly jobId:string; readonly taskId:string|null; readonly projectId:string; readonly commandId:string; readonly pid:number|null; readonly startedAt:string|null; readonly finishedAt:string|null; readonly status:JobStatus; readonly exitCode:number|null; readonly stdoutPath:string; readonly stderrPath:string; readonly error:unknown; }
type Row={job_id:string;task_id:string|null;project_id:string;command_id:string;pid:number|null;started_at:string|null;finished_at:string|null;status:JobStatus;exit_code:number|null;stdout_path:string;stderr_path:string;error_json:string|null};
function map(r:Row):JobRecord{return{jobId:r.job_id,taskId:r.task_id,projectId:r.project_id,commandId:r.command_id,pid:r.pid,startedAt:r.started_at,finishedAt:r.finished_at,status:r.status,exitCode:r.exit_code,stdoutPath:r.stdout_path,stderrPath:r.stderr_path,error:r.error_json===null?null:JSON.parse(r.error_json)};}

export class JobManager {
  private readonly controllers=new Map<string,AbortController>();
  public constructor(private readonly db:SqliteDatabase,private readonly runner:RestrictedCommandRunner,private readonly outputDir:string,private readonly maxConcurrentJobs=1){}
  public async start(projectId:string,principal:Principal,commandId:string,taskId?:string):Promise<JobRecord>{
    const running=(this.db.raw.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='RUNNING'").get() as {n:number}).n;if(running>=this.maxConcurrentJobs)throw new ConflictError('Concurrent job limit reached');
    const id=randomUUID(),dir=path.join(this.outputDir,'jobs',id),stdoutPath=path.join(dir,'stdout.log'),stderrPath=path.join(dir,'stderr.log');await fs.mkdir(dir,{recursive:true,mode:0o750});const runningAfterPrepare=(this.db.raw.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='RUNNING'").get() as {n:number}).n;if(runningAfterPrepare>=this.maxConcurrentJobs)throw new ConflictError('Concurrent job limit reached');const now=new Date().toISOString();
    this.db.raw.prepare('INSERT INTO jobs(job_id,task_id,project_id,command_id,pid,started_at,finished_at,status,exit_code,stdout_path,stderr_path,error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,taskId??null,projectId,commandId,null,now,null,'RUNNING',null,stdoutPath,stderrPath,null);
    const controller=new AbortController();this.controllers.set(id,controller);
    void this.runner.run(projectId,principal,commandId,{signal:controller.signal,onSpawn:(pid)=>this.db.raw.prepare('UPDATE jobs SET pid=? WHERE job_id=?').run(pid??null,id)})
      .then(async result=>{await fs.writeFile(stdoutPath,result.stdout,{mode:0o640});await fs.writeFile(stderrPath,result.stderr,{mode:0o640});const status:JobStatus=result.exitCode===0?'COMPLETED':'FAILED';this.db.raw.prepare('UPDATE jobs SET status=?,exit_code=?,finished_at=? WHERE job_id=?').run(status,result.exitCode,new Date().toISOString(),id);if(taskId!==undefined)this.appendTaskCommand(taskId,{jobId:id,commandId,status,exitCode:result.exitCode});})
      .catch(async error=>{await fs.writeFile(stderrPath,JSON.stringify(redactError(error)),{mode:0o640});const status:JobStatus=controller.signal.aborted?'CANCELLED':'FAILED';this.db.raw.prepare('UPDATE jobs SET status=?,finished_at=?,error_json=? WHERE job_id=?').run(status,new Date().toISOString(),JSON.stringify(redactError(error)),id);if(taskId!==undefined)this.appendTaskCommand(taskId,{jobId:id,commandId,status,error:redactError(error)});})
      .finally(()=>this.controllers.delete(id));
    return this.getRequired(id);
  }
  public get(jobId:string):JobRecord|null{const r=this.db.raw.prepare('SELECT * FROM jobs WHERE job_id=?').get(jobId) as Row|undefined;return r===undefined?null:map(r);}
  public list(projectId?:string):readonly JobRecord[]{const rows=(projectId===undefined?this.db.raw.prepare('SELECT * FROM jobs ORDER BY started_at DESC').all():this.db.raw.prepare('SELECT * FROM jobs WHERE project_id=? ORDER BY started_at DESC').all(projectId)) as Row[];return rows.map(map);}
  public cancel(jobId:string):JobRecord{const job=this.getRequired(jobId);if(job.status!=='RUNNING')throw new ConflictError('Only running jobs can be cancelled');const controller=this.controllers.get(jobId);if(controller===undefined)throw new ConflictError('Running job is not attached to this Agent process');controller.abort();return this.getRequired(jobId);}
  public reconcileAfterRestart():number{const rows=this.db.raw.prepare("SELECT * FROM jobs WHERE status='RUNNING'").all() as Row[];let changed=0;for(const row of rows){let alive=false;if(row.pid!==null){try{process.kill(row.pid,0);alive=true;}catch{alive=false;}}if(!alive){this.db.raw.prepare("UPDATE jobs SET status='UNKNOWN',finished_at=? WHERE job_id=?").run(new Date().toISOString(),row.job_id);changed+=1;}}return changed;}
  private appendTaskCommand(taskId:string,value:unknown):void{const row=this.db.raw.prepare('SELECT commands_executed_json FROM tasks WHERE task_id=?').get(taskId) as {commands_executed_json:string}|undefined;if(row===undefined)return;const items=JSON.parse(row.commands_executed_json) as unknown[];items.push(redactValue(value));this.db.raw.prepare('UPDATE tasks SET commands_executed_json=?,updated_at=? WHERE task_id=?').run(JSON.stringify(items),new Date().toISOString(),taskId);}
  private getRequired(id:string):JobRecord{const j=this.get(id);if(j===null)throw new ValidationError('Job not found');return j;}
}

import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../database/sqlite.js';
import type { TaskStatus } from '../core/types.js';
import { ConflictError, ValidationError } from '../core/errors.js';
import { redactValue } from '../security/redaction.js';

export interface TaskRecord {
  readonly taskId:string; readonly projectId:string; readonly title:string; readonly status:TaskStatus;
  readonly createdAt:string; readonly updatedAt:string; readonly currentStep:string|null; readonly completedSteps:readonly string[];
  readonly remainingSteps:readonly string[]; readonly filesModified:readonly string[]; readonly commandsExecuted:readonly unknown[];
  readonly testsRun:readonly string[]; readonly testResults:readonly unknown[]; readonly lastError:unknown; readonly checkpoint:string|null;
  readonly resumable:boolean; readonly gitCommitBefore:string|null; readonly gitCommitAfter:string|null; readonly deploymentId:string|null;
  readonly healthCheckResults:unknown; readonly rollbackState:unknown; readonly recoveryAttempts:number; readonly metadata:Readonly<Record<string,unknown>>;
}
type Row={task_id:string;project_id:string;title:string;status:TaskStatus;created_at:string;updated_at:string;current_step:string|null;completed_steps_json:string;remaining_steps_json:string;files_modified_json:string;commands_executed_json:string;tests_run_json:string;test_results_json:string;last_error_json:string|null;checkpoint:string|null;resumable:number;git_commit_before:string|null;git_commit_after:string|null;deployment_id:string|null;health_check_results_json:string|null;rollback_state_json:string|null;recovery_attempts:number;metadata_json:string};
const parse=(v:string|null):unknown=>v===null?null:JSON.parse(v);
function map(r:Row):TaskRecord{return{taskId:r.task_id,projectId:r.project_id,title:r.title,status:r.status,createdAt:r.created_at,updatedAt:r.updated_at,currentStep:r.current_step,completedSteps:parse(r.completed_steps_json) as string[],remainingSteps:parse(r.remaining_steps_json) as string[],filesModified:parse(r.files_modified_json) as string[],commandsExecuted:parse(r.commands_executed_json) as unknown[],testsRun:parse(r.tests_run_json) as string[],testResults:parse(r.test_results_json) as unknown[],lastError:parse(r.last_error_json),checkpoint:r.checkpoint,resumable:r.resumable===1,gitCommitBefore:r.git_commit_before,gitCommitAfter:r.git_commit_after,deploymentId:r.deployment_id,healthCheckResults:parse(r.health_check_results_json),rollbackState:parse(r.rollback_state_json),recoveryAttempts:r.recovery_attempts,metadata:parse(r.metadata_json) as Record<string,unknown>};}

export class TaskEngine {
  public constructor(private readonly db:SqliteDatabase){}
  public create(projectId:string,title:string,remainingSteps:readonly string[]=[]):TaskRecord{
    if(title.trim()==='') throw new ValidationError('Task title is required'); const id=randomUUID(), now=new Date().toISOString();
    this.db.raw.prepare(`INSERT INTO tasks(task_id,project_id,title,status,created_at,updated_at,current_step,completed_steps_json,remaining_steps_json,files_modified_json,commands_executed_json,tests_run_json,test_results_json,last_error_json,checkpoint,resumable,git_commit_before,git_commit_after,deployment_id,health_check_results_json,rollback_state_json,recovery_attempts,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,projectId,title,'PENDING',now,now,null,'[]',JSON.stringify(remainingSteps),'[]','[]','[]','[]',null,null,1,null,null,null,null,null,0,'{}'); return this.getRequired(id);
  }
  public get(taskId:string):TaskRecord|null{const r=this.db.raw.prepare('SELECT * FROM tasks WHERE task_id=?').get(taskId) as Row|undefined;return r===undefined?null:map(r);}
  public list(projectId?:string):readonly TaskRecord[]{const rows=(projectId===undefined?this.db.raw.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all():this.db.raw.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at DESC').all(projectId)) as Row[];return rows.map(map);}
  public setStatus(taskId:string,status:TaskStatus):TaskRecord{const current=this.getRequired(taskId); if(['COMPLETED','CANCELLED'].includes(current.status) && current.status!==status) throw new ConflictError('Terminal task cannot transition'); this.db.raw.prepare('UPDATE tasks SET status=?,updated_at=? WHERE task_id=?').run(status,new Date().toISOString(),taskId);return this.getRequired(taskId);}
  public resume(taskId:string):TaskRecord{const t=this.getRequired(taskId);if(!t.resumable)throw new ConflictError('Task is not resumable');if(!['PENDING','PAUSED','FAILED','RECOVERY_REQUIRED','WAITING_FOR_USER'].includes(t.status))throw new ConflictError('Task cannot be resumed from current status'); if(t.status==='RECOVERY_REQUIRED') this.db.raw.prepare('UPDATE tasks SET recovery_attempts=recovery_attempts+1 WHERE task_id=?').run(taskId);return this.setStatus(taskId,'RUNNING');}
  public pause(taskId:string):TaskRecord{const t=this.getRequired(taskId);if(t.status!=='RUNNING')throw new ConflictError('Only running tasks can be paused');return this.setStatus(taskId,'PAUSED');}
  public cancel(taskId:string):TaskRecord{return this.setStatus(taskId,'CANCELLED');}
  public checkpoint(taskId:string,input:{currentStep?:string|null;completedSteps?:readonly string[];remainingSteps?:readonly string[];metadata?:Readonly<Record<string,unknown>>}):TaskRecord{
    this.getRequired(taskId);const id=randomUUID(),now=new Date().toISOString(),safe=redactValue(input.metadata??{});const current=input.currentStep??null,completed=input.completedSteps??[],remaining=input.remainingSteps??[];
    this.db.raw.exec('BEGIN IMMEDIATE;');try{this.db.raw.prepare('INSERT INTO task_checkpoints(checkpoint_id,task_id,created_at,current_step,completed_steps_json,remaining_steps_json,metadata_json) VALUES(?,?,?,?,?,?,?)').run(id,taskId,now,current,JSON.stringify(completed),JSON.stringify(remaining),JSON.stringify(safe));this.db.raw.prepare('UPDATE tasks SET checkpoint=?,current_step=?,completed_steps_json=?,remaining_steps_json=?,updated_at=? WHERE task_id=?').run(id,current,JSON.stringify(completed),JSON.stringify(remaining),now,taskId);this.db.raw.exec('COMMIT;');}catch(e){this.db.raw.exec('ROLLBACK;');throw e;}return this.getRequired(taskId);
  }
  public recordError(taskId:string,error:unknown):TaskRecord{this.db.raw.prepare('UPDATE tasks SET last_error_json=?,status=?,updated_at=? WHERE task_id=?').run(JSON.stringify(redactValue(error)),'FAILED',new Date().toISOString(),taskId);return this.getRequired(taskId);}
  public markInterruptedForRecovery():number{const r=this.db.raw.prepare(`UPDATE tasks SET status='RECOVERY_REQUIRED',updated_at=? WHERE status IN ('RUNNING','DEPLOYING','HEALTH_CHECKING','RECOVERING')`).run(new Date().toISOString());return Number(r.changes);}

  public recordFileModified(taskId:string,filePath:string):TaskRecord{this.appendUniqueString(taskId,'files_modified_json',filePath);return this.getRequired(taskId);}
  public recordCommand(taskId:string,command:unknown):TaskRecord{this.appendJson(taskId,'commands_executed_json',redactValue(command));return this.getRequired(taskId);}
  public recordTestResult(taskId:string,name:string,result:unknown):TaskRecord{this.appendUniqueString(taskId,'tests_run_json',name);this.appendJson(taskId,'test_results_json',redactValue(result));return this.getRequired(taskId);}
  public setGitReferences(taskId:string,before:string|null,after:string|null):TaskRecord{this.getRequired(taskId);this.db.raw.prepare('UPDATE tasks SET git_commit_before=?,git_commit_after=?,updated_at=? WHERE task_id=?').run(before,after,new Date().toISOString(),taskId);return this.getRequired(taskId);}
  public setDeployment(taskId:string,deploymentId:string|null):TaskRecord{this.getRequired(taskId);this.db.raw.prepare('UPDATE tasks SET deployment_id=?,updated_at=? WHERE task_id=?').run(deploymentId,new Date().toISOString(),taskId);return this.getRequired(taskId);}
  public setHealthResult(taskId:string,result:unknown):TaskRecord{this.getRequired(taskId);this.db.raw.prepare('UPDATE tasks SET health_check_results_json=?,updated_at=? WHERE task_id=?').run(JSON.stringify(redactValue(result)),new Date().toISOString(),taskId);return this.getRequired(taskId);}
  public setRollbackState(taskId:string,state:unknown):TaskRecord{this.getRequired(taskId);this.db.raw.prepare('UPDATE tasks SET rollback_state_json=?,updated_at=? WHERE task_id=?').run(JSON.stringify(redactValue(state)),new Date().toISOString(),taskId);return this.getRequired(taskId);}
  private appendUniqueString(taskId:string,column:'files_modified_json'|'tests_run_json',value:string):void{this.getRequired(taskId);const row=this.db.raw.prepare(`SELECT ${column} AS value FROM tasks WHERE task_id=?`).get(taskId) as {value:string};const items=JSON.parse(row.value) as string[];if(!items.includes(value))items.push(value);this.db.raw.prepare(`UPDATE tasks SET ${column}=?,updated_at=? WHERE task_id=?`).run(JSON.stringify(items),new Date().toISOString(),taskId);}
  private appendJson(taskId:string,column:'commands_executed_json'|'test_results_json',value:unknown):void{this.getRequired(taskId);const row=this.db.raw.prepare(`SELECT ${column} AS value FROM tasks WHERE task_id=?`).get(taskId) as {value:string};const items=JSON.parse(row.value) as unknown[];items.push(value);this.db.raw.prepare(`UPDATE tasks SET ${column}=?,updated_at=? WHERE task_id=?`).run(JSON.stringify(items),new Date().toISOString(),taskId);}
  private getRequired(id:string):TaskRecord{const t=this.get(id);if(t===null)throw new ValidationError('Task not found');return t;}
}

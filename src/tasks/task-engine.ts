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

export interface TaskJobController {
  activeForTask(taskId:string):{readonly jobId:string}|null;
  cancelAndWait(jobId:string):Promise<unknown>;
}

type BlockingWork={kind:'job'|'operation';id:string;status:string};

const ALLOWED:Readonly<Record<TaskStatus,readonly TaskStatus[]>>={
  PENDING:['RUNNING','DEPLOYING','FAILED','RECOVERING','RECOVERY_REQUIRED','ROLLBACK_REQUIRED','WAITING_FOR_USER','CANCELLED'],
  RUNNING:['PAUSED','FAILED','WAITING_FOR_USER','RECOVERY_REQUIRED','DEPLOYING','HEALTH_CHECKING','RECOVERING','ROLLBACK_REQUIRED','ROLLING_BACK','COMPLETED','ROLLED_BACK','CANCELLED'],
  PAUSED:['RUNNING','FAILED','RECOVERING','RECOVERY_REQUIRED','ROLLBACK_REQUIRED','WAITING_FOR_USER','CANCELLED'],
  FAILED:['RUNNING','RECOVERING','RECOVERY_REQUIRED','ROLLBACK_REQUIRED','WAITING_FOR_USER','CANCELLED'],
  WAITING_FOR_USER:['RUNNING','RECOVERING','RECOVERY_REQUIRED','ROLLBACK_REQUIRED','FAILED','CANCELLED'],
  RECOVERY_REQUIRED:['RUNNING','RECOVERING','ROLLBACK_REQUIRED','WAITING_FOR_USER','FAILED','CANCELLED'],
  DEPLOYING:['HEALTH_CHECKING','FAILED','RECOVERY_REQUIRED','ROLLBACK_REQUIRED','CANCELLED'],
  HEALTH_CHECKING:['COMPLETED','ROLLED_BACK','FAILED','RECOVERY_REQUIRED','ROLLBACK_REQUIRED','CANCELLED'],
  RECOVERING:['RUNNING','RECOVERY_REQUIRED','FAILED','ROLLBACK_REQUIRED','WAITING_FOR_USER','COMPLETED','CANCELLED'],
  ROLLBACK_REQUIRED:['ROLLING_BACK','WAITING_FOR_USER','FAILED','CANCELLED'],
  ROLLING_BACK:['HEALTH_CHECKING','ROLLED_BACK','FAILED','WAITING_FOR_USER','CANCELLED'],
  COMPLETED:[],ROLLED_BACK:[],CANCELLED:[],
};

export class TaskEngine {
  private jobController:TaskJobController|undefined;
  public constructor(private readonly db:SqliteDatabase){}
  public bindJobController(controller:TaskJobController):void{this.jobController=controller;}

  public create(projectId:string,title:string,remainingSteps:readonly string[]=[]):TaskRecord{
    if(title.trim()==='') throw new ValidationError('Task title is required'); const id=randomUUID(), now=new Date().toISOString();
    this.db.raw.prepare(`INSERT INTO tasks(task_id,project_id,title,status,created_at,updated_at,current_step,completed_steps_json,remaining_steps_json,files_modified_json,commands_executed_json,tests_run_json,test_results_json,last_error_json,checkpoint,resumable,git_commit_before,git_commit_after,deployment_id,health_check_results_json,rollback_state_json,recovery_attempts,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,projectId,title,'PENDING',now,now,null,'[]',JSON.stringify(remainingSteps),'[]','[]','[]','[]',null,null,1,null,null,null,null,null,0,'{}'); return this.getRequired(id);
  }
  public get(taskId:string):TaskRecord|null{const r=this.db.raw.prepare('SELECT * FROM tasks WHERE task_id=?').get(taskId) as Row|undefined;return r===undefined?null:map(r);}
  public list(projectId?:string):readonly TaskRecord[]{const rows=(projectId===undefined?this.db.raw.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all():this.db.raw.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at DESC').all(projectId)) as Row[];return rows.map(map);}

  public setStatus(taskId:string,status:TaskStatus):TaskRecord{
    const current=this.getRequired(taskId);if(current.status===status)return current;
    if(!ALLOWED[current.status].includes(status))throw new ConflictError(`Task cannot transition from ${current.status} to ${status}`);
    const result=this.db.raw.prepare('UPDATE tasks SET status=?,updated_at=? WHERE task_id=? AND status=?').run(status,new Date().toISOString(),taskId,current.status);
    if(Number(result.changes)!==1)throw new ConflictError('Task state changed concurrently');
    return this.getRequired(taskId);
  }

  public resume(taskId:string):TaskRecord{
    const t=this.getRequired(taskId);
    if(!t.resumable)throw new ConflictError('Task is not resumable');
    if(!['PENDING','PAUSED','FAILED','RECOVERY_REQUIRED','WAITING_FOR_USER'].includes(t.status))throw new ConflictError('Task cannot be resumed from current status');
    const blocking=this.blockingWork(taskId);if(blocking!==null)throw new ConflictError(`Task has unresolved ${blocking.kind} ${blocking.id} in ${blocking.status} state`);
    if(t.status==='RECOVERY_REQUIRED'&&!this.hasVerifiedResumeDecision(taskId))throw new ConflictError('Recovery assessment must recommend resume before a recovery-required task can resume');
    if(t.status==='RECOVERY_REQUIRED')this.db.raw.prepare('UPDATE tasks SET recovery_attempts=recovery_attempts+1 WHERE task_id=?').run(taskId);
    return this.setStatus(taskId,'RUNNING');
  }
  public pause(taskId:string):TaskRecord{const t=this.getRequired(taskId);if(t.status!=='RUNNING')throw new ConflictError('Only running tasks can be paused');const blocking=this.blockingWork(taskId);if(blocking!==null)throw new ConflictError(`Task cannot be paused while ${blocking.kind} ${blocking.id} is ${blocking.status}`);return this.setStatus(taskId,'PAUSED');}
  public async cancel(taskId:string):Promise<TaskRecord>{const t=this.getRequired(taskId);if(t.status==='CANCELLED')return t;if(['COMPLETED','ROLLED_BACK'].includes(t.status))throw new ConflictError('Terminal task cannot be cancelled');const operation=this.blockingOperation(taskId);if(operation!==null)throw new ConflictError(`Task cannot be cancelled while persistent operation ${operation.id} is ${operation.status}`);const active=this.activeJobId(taskId);if(active!==null){if(this.jobController===undefined)throw new ConflictError('Task job controller is not attached');await this.jobController.cancelAndWait(active);}const unknown=this.unknownJob(taskId);if(unknown!==null)throw new ConflictError(`Task cannot be cancelled while job ${unknown.id} is UNKNOWN`);return this.setStatus(taskId,'CANCELLED');}

  public checkpoint(taskId:string,input:{currentStep?:string|null;completedSteps?:readonly string[];remainingSteps?:readonly string[];metadata?:Readonly<Record<string,unknown>>}):TaskRecord{
    this.getRequired(taskId);const id=randomUUID(),now=new Date().toISOString(),safe=redactValue(input.metadata??{});const current=input.currentStep??null,completed=input.completedSteps??[],remaining=input.remainingSteps??[];
    this.db.raw.exec('BEGIN IMMEDIATE;');try{this.db.raw.prepare('INSERT INTO task_checkpoints(checkpoint_id,task_id,created_at,current_step,completed_steps_json,remaining_steps_json,metadata_json) VALUES(?,?,?,?,?,?,?)').run(id,taskId,now,current,JSON.stringify(completed),JSON.stringify(remaining),JSON.stringify(safe));this.db.raw.prepare('UPDATE tasks SET checkpoint=?,current_step=?,completed_steps_json=?,remaining_steps_json=?,updated_at=? WHERE task_id=?').run(id,current,JSON.stringify(completed),JSON.stringify(remaining),now,taskId);this.db.raw.exec('COMMIT;');}catch(e){this.db.raw.exec('ROLLBACK;');throw e;}return this.getRequired(taskId);
  }
  public recordError(taskId:string,error:unknown):TaskRecord{const current=this.getRequired(taskId);if(current.status==='FAILED'){this.db.raw.prepare('UPDATE tasks SET last_error_json=?,updated_at=? WHERE task_id=?').run(JSON.stringify(redactValue(error)),new Date().toISOString(),taskId);return this.getRequired(taskId);}if(!ALLOWED[current.status].includes('FAILED'))throw new ConflictError(`Task cannot fail from ${current.status}`);const result=this.db.raw.prepare('UPDATE tasks SET last_error_json=?,status=?,updated_at=? WHERE task_id=? AND status=?').run(JSON.stringify(redactValue(error)),'FAILED',new Date().toISOString(),taskId,current.status);if(Number(result.changes)!==1)throw new ConflictError('Task state changed concurrently');return this.getRequired(taskId);}
  public markInterruptedForRecovery():number{const r=this.db.raw.prepare(`UPDATE tasks SET status='RECOVERY_REQUIRED',updated_at=? WHERE status IN ('RUNNING','DEPLOYING','HEALTH_CHECKING','RECOVERING','ROLLING_BACK')`).run(new Date().toISOString());return Number(r.changes);}
  public markUnknownWorkForRecovery():number{const now=new Date().toISOString();const r=this.db.raw.prepare(`UPDATE tasks SET status='RECOVERY_REQUIRED',updated_at=? WHERE status NOT IN ('COMPLETED','ROLLED_BACK','CANCELLED') AND (EXISTS (SELECT 1 FROM jobs j WHERE j.task_id=tasks.task_id AND j.status='UNKNOWN') OR EXISTS (SELECT 1 FROM persistent_operations o WHERE o.task_id=tasks.task_id AND o.status='UNKNOWN'))`).run(now);return Number(r.changes);}

  public recordFileModified(taskId:string,filePath:string):TaskRecord{this.appendUniqueString(taskId,'files_modified_json',filePath);return this.getRequired(taskId);}
  public recordCommand(taskId:string,command:unknown):TaskRecord{this.appendJson(taskId,'commands_executed_json',redactValue(command));return this.getRequired(taskId);}
  public recordTestResult(taskId:string,name:string,result:unknown):TaskRecord{this.appendUniqueString(taskId,'tests_run_json',name);this.appendJson(taskId,'test_results_json',redactValue(result));return this.getRequired(taskId);}
  public setGitReferences(taskId:string,before:string|null,after:string|null):TaskRecord{this.getRequired(taskId);this.db.raw.prepare('UPDATE tasks SET git_commit_before=?,git_commit_after=?,updated_at=? WHERE task_id=?').run(before,after,new Date().toISOString(),taskId);return this.getRequired(taskId);}
  public setDeployment(taskId:string,deploymentId:string|null):TaskRecord{this.getRequired(taskId);this.db.raw.prepare('UPDATE tasks SET deployment_id=?,updated_at=? WHERE task_id=?').run(deploymentId,new Date().toISOString(),taskId);return this.getRequired(taskId);}
  public setHealthResult(taskId:string,result:unknown):TaskRecord{this.getRequired(taskId);this.db.raw.prepare('UPDATE tasks SET health_check_results_json=?,updated_at=? WHERE task_id=?').run(JSON.stringify(redactValue(result)),new Date().toISOString(),taskId);return this.getRequired(taskId);}
  public setRollbackState(taskId:string,state:unknown):TaskRecord{this.getRequired(taskId);this.db.raw.prepare('UPDATE tasks SET rollback_state_json=?,updated_at=? WHERE task_id=?').run(JSON.stringify(redactValue(state)),new Date().toISOString(),taskId);return this.getRequired(taskId);}

  private activeJobId(taskId:string):string|null{const viaController=this.jobController?.activeForTask(taskId);if(viaController!==undefined&&viaController!==null)return viaController.jobId;const row=this.db.raw.prepare("SELECT job_id FROM jobs WHERE task_id=? AND status='RUNNING' ORDER BY started_at DESC LIMIT 1").get(taskId) as {job_id:string}|undefined;return row?.job_id??null;}
  private unknownJob(taskId:string):{id:string}|null{const row=this.db.raw.prepare("SELECT job_id FROM jobs WHERE task_id=? AND status='UNKNOWN' ORDER BY COALESCE(started_at,finished_at) DESC LIMIT 1").get(taskId) as {job_id:string}|undefined;return row===undefined?null:{id:row.job_id};}
  private blockingOperation(taskId:string):{id:string;status:string}|null{const row=this.db.raw.prepare("SELECT operation_id,status FROM persistent_operations WHERE task_id=? AND status IN ('RUNNING','UNKNOWN') ORDER BY created_at DESC LIMIT 1").get(taskId) as {operation_id:string;status:string}|undefined;return row===undefined?null:{id:row.operation_id,status:row.status};}
  private blockingWork(taskId:string):BlockingWork|null{const active=this.activeJobId(taskId);if(active!==null)return{kind:'job',id:active,status:'RUNNING'};const unknown=this.unknownJob(taskId);if(unknown!==null)return{kind:'job',id:unknown.id,status:'UNKNOWN'};const operation=this.blockingOperation(taskId);return operation===null?null:{kind:'operation',id:operation.id,status:operation.status};}
  private hasVerifiedResumeDecision(taskId:string):boolean{const row=this.db.raw.prepare('SELECT decision_json FROM recovery_runs WHERE task_id=? AND decision_json IS NOT NULL ORDER BY attempt DESC LIMIT 1').get(taskId) as {decision_json:string}|undefined;if(row===undefined)return false;try{const decision=JSON.parse(row.decision_json) as {action?:unknown};return decision.action==='RESUME_RECOMMENDED';}catch{return false;}}
  private appendUniqueString(taskId:string,column:'files_modified_json'|'tests_run_json',value:string):void{this.getRequired(taskId);this.db.raw.exec('BEGIN IMMEDIATE;');try{const row=this.db.raw.prepare(`SELECT ${column} AS value FROM tasks WHERE task_id=?`).get(taskId) as {value:string};const items=JSON.parse(row.value) as string[];if(!items.includes(value))items.push(value);this.db.raw.prepare(`UPDATE tasks SET ${column}=?,updated_at=? WHERE task_id=?`).run(JSON.stringify(items),new Date().toISOString(),taskId);this.db.raw.exec('COMMIT;');}catch(error){this.db.raw.exec('ROLLBACK;');throw error;}}
  private appendJson(taskId:string,column:'commands_executed_json'|'test_results_json',value:unknown):void{this.getRequired(taskId);this.db.raw.exec('BEGIN IMMEDIATE;');try{const row=this.db.raw.prepare(`SELECT ${column} AS value FROM tasks WHERE task_id=?`).get(taskId) as {value:string};const items=JSON.parse(row.value) as unknown[];items.push(value);this.db.raw.prepare(`UPDATE tasks SET ${column}=?,updated_at=? WHERE task_id=?`).run(JSON.stringify(items),new Date().toISOString(),taskId);this.db.raw.exec('COMMIT;');}catch(error){this.db.raw.exec('ROLLBACK;');throw error;}}
  private getRequired(id:string):TaskRecord{const t=this.get(id);if(t===null)throw new ValidationError('Task not found');return t;}
}

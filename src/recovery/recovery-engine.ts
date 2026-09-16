import { randomUUID } from 'node:crypto';
import type { Authorizer, ProjectStore } from '../core/interfaces.js';
import type { Principal, ProjectPermission, RecoveryStatus } from '../core/types.js';
import { AttemptLimitError, AuthorizationError, ValidationError } from '../core/errors.js';
import type { SqliteDatabase } from '../database/sqlite.js';
import { DeploymentEngine } from '../deployment/deployment-engine.js';
import { TaskEngine } from '../tasks/task-engine.js';
import { redactError, redactValue } from '../security/redaction.js';
import { RecoveryEvidenceCollector, type RecoveryEvidence } from './evidence.js';

export interface RecoveryDecision {
  readonly action: 'RESUME_RECOMMENDED' | 'ROLLBACK_REQUIRED' | 'WAITING_FOR_USER';
  readonly reason: string;
  readonly lastConfirmedState: Readonly<Record<string, unknown>>;
}

export interface RecoveryRun {
  readonly recoveryId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly deploymentId: string | null;
  readonly attempt: number;
  readonly status: RecoveryStatus;
  readonly reason: string;
  readonly evidence: RecoveryEvidence;
  readonly decision: RecoveryDecision | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly error: unknown;
}

type Row = {
  recovery_id:string;task_id:string;project_id:string;deployment_id:string|null;attempt:number;status:RecoveryStatus;reason:string;
  evidence_json:string;decision_json:string|null;started_at:string;finished_at:string|null;error_json:string|null;
};
function parse(value:string|null):unknown{return value===null?null:JSON.parse(value) as unknown;}
function map(row:Row):RecoveryRun{return{recoveryId:row.recovery_id,taskId:row.task_id,projectId:row.project_id,deploymentId:row.deployment_id,attempt:row.attempt,status:row.status,reason:row.reason,evidence:parse(row.evidence_json) as RecoveryEvidence,decision:parse(row.decision_json) as RecoveryDecision|null,startedAt:row.started_at,finishedAt:row.finished_at,error:parse(row.error_json)};}
function systemPrincipal(projectId:string,permissions:readonly ProjectPermission[]):Principal{return{id:'recovery-engine',kind:'system',projectScopes:[projectId],permissions};}

export class RecoveryEngine {
  public constructor(
    private readonly db:SqliteDatabase,
    private readonly projects:ProjectStore,
    private readonly authorizer:Authorizer,
    private readonly tasks:TaskEngine,
    private readonly deployments:DeploymentEngine,
    private readonly evidence:RecoveryEvidenceCollector,
    private readonly maxAttempts=3,
  ) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new ValidationError('Recovery max attempts must be a positive integer');
  }

  public get(recoveryId:string):RecoveryRun|null{const row=this.db.raw.prepare('SELECT * FROM recovery_runs WHERE recovery_id=?').get(recoveryId) as Row|undefined;return row===undefined?null:map(row);}
  public list(taskId:string):readonly RecoveryRun[]{return (this.db.raw.prepare('SELECT * FROM recovery_runs WHERE task_id=? ORDER BY attempt DESC').all(taskId) as Row[]).map(map);}

  public async assess(taskId:string,projectId:string,principal:Principal,reason='Recovery assessment requested'):Promise<RecoveryRun>{
    this.authorizer.assertAllowed(principal,'recovery:run',projectId);
    const project=this.projects.get(projectId);if(project===null||!project.enabled)throw new ValidationError('Project is not available');
    if(!project.permissions.includes('recovery:run'))throw new AuthorizationError('Project does not permit recovery execution');
    const task=this.tasks.get(taskId);if(task===null||task.projectId!==projectId)throw new ValidationError('Task is not available for this project');
    if(['COMPLETED','ROLLED_BACK','CANCELLED'].includes(task.status))throw new ValidationError('Terminal task does not require recovery');

    const countRow=this.db.raw.prepare('SELECT COUNT(*) AS count FROM recovery_runs WHERE task_id=?').get(taskId) as {count:number};
    const attempt=Number(countRow.count)+1;
    if(attempt>this.maxAttempts){
      if(task.deploymentId!==null)this.tasks.setStatus(taskId,'ROLLBACK_REQUIRED');else this.tasks.setStatus(taskId,'WAITING_FOR_USER');
      throw new AttemptLimitError(`Recovery attempt limit of ${this.maxAttempts} reached`);
    }

    const recoveryId=randomUUID();const startedAt=new Date().toISOString();
    this.tasks.setStatus(taskId,'RECOVERING');
    const internal=systemPrincipal(projectId,['recovery:read']);
    let collected:RecoveryEvidence;
    try{collected=await this.evidence.collect(taskId,projectId,internal);}catch(error){
      const safe=redactError(error);
      const fallback=redactValue({projectId,taskId,collectedAt:new Date().toISOString(),task:{status:task.status},deployment:null,validation:[],jobs:[],health:[],git:{available:false},logs:{available:false},evidenceError:safe}) as unknown as RecoveryEvidence;
      this.db.raw.prepare('INSERT INTO recovery_runs(recovery_id,task_id,project_id,deployment_id,attempt,status,reason,evidence_json,decision_json,started_at,finished_at,error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(recoveryId,taskId,projectId,task.deploymentId,attempt,'FAILED',reason,JSON.stringify(fallback),null,startedAt,new Date().toISOString(),JSON.stringify(safe));
      this.tasks.setStatus(taskId,'WAITING_FOR_USER');
      return this.getRequired(recoveryId);
    }

    this.db.raw.prepare('INSERT INTO recovery_runs(recovery_id,task_id,project_id,deployment_id,attempt,status,reason,evidence_json,decision_json,started_at,finished_at,error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(recoveryId,taskId,projectId,task.deploymentId,attempt,'ASSESSING',reason,JSON.stringify(redactValue(collected)),null,startedAt,null,null);

    const decision=this.decide(taskId);
    const status:RecoveryStatus=decision.action==='RESUME_RECOMMENDED'?'RESUME_RECOMMENDED':decision.action==='ROLLBACK_REQUIRED'?'ROLLBACK_REQUIRED':'MANUAL_REQUIRED';
    const finishedAt=new Date().toISOString();
    this.db.raw.prepare('UPDATE recovery_runs SET status=?,decision_json=?,finished_at=? WHERE recovery_id=?').run(status,JSON.stringify(redactValue(decision)),finishedAt,recoveryId);
    if(decision.action==='ROLLBACK_REQUIRED')this.tasks.setStatus(taskId,'ROLLBACK_REQUIRED');
    else if(decision.action==='WAITING_FOR_USER')this.tasks.setStatus(taskId,'WAITING_FOR_USER');
    else this.tasks.setStatus(taskId,'RECOVERY_REQUIRED');
    this.tasks.checkpoint(taskId,{currentStep:'recovery-assessed',completedSteps:task.completedSteps,remainingSteps:task.remainingSteps,metadata:{recoveryId,attempt,decision}});
    return this.getRequired(recoveryId);
  }

  private decide(taskId:string):RecoveryDecision{
    const task=this.tasks.get(taskId);if(task===null)throw new ValidationError('Task not found');
    const deployment=task.deploymentId===null?null:this.deployments.get(task.deploymentId);
    const lastConfirmedState={checkpoint:task.checkpoint,currentStep:task.currentStep,gitCommitBefore:task.gitCommitBefore,gitCommitAfter:task.gitCommitAfter,deploymentStatus:deployment?.status??null,health:task.healthCheckResults};
    if(deployment!==null&&deployment.status==='FAILED'&&deployment.rollbackAvailable){
      return{action:'ROLLBACK_REQUIRED',reason:'Deployment failed and a last-known-good rollback reference exists',lastConfirmedState};
    }
    if(task.deploymentId!==null&&deployment===null){
      return{action:'WAITING_FOR_USER',reason:'Task references a deployment record that is missing',lastConfirmedState};
    }
    if(deployment!==null&&deployment.status==='SUCCEEDED'){
      return{action:'RESUME_RECOMMENDED',reason:'Deployment record confirms success; resume from the last checkpoint after reviewing evidence',lastConfirmedState};
    }
    if(task.resumable&&task.checkpoint!==null){
      return{action:'RESUME_RECOMMENDED',reason:'A persistent checkpoint exists; no mutating step is replayed automatically',lastConfirmedState};
    }
    return{action:'WAITING_FOR_USER',reason:'No confirmed safe resume or rollback state is available',lastConfirmedState};
  }

  private getRequired(recoveryId:string):RecoveryRun{const run=this.get(recoveryId);if(run===null)throw new ValidationError('Recovery run not found');return run;}
}

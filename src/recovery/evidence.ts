import type { Authorizer, ProjectStore } from '../core/interfaces.js';
import type { Principal, ProjectPermission } from '../core/types.js';
import { AuthorizationError, ValidationError } from '../core/errors.js';
import type { SqliteDatabase } from '../database/sqlite.js';
import { GitService } from '../git/git-service.js';
import { JournalLogReader } from '../logs/journal-logs.js';
import { TaskEngine } from '../tasks/task-engine.js';
import { DeploymentEngine } from '../deployment/deployment-engine.js';
import type { ProjectServiceManager } from '../services/service-controller.js';
import { redactError, redactValue } from '../security/redaction.js';

export interface RecoveryEvidence {
  readonly projectId: string;
  readonly taskId: string;
  readonly collectedAt: string;
  readonly task: Readonly<Record<string, unknown>>;
  readonly deployment: Readonly<Record<string, unknown>> | null;
  readonly operations: readonly Readonly<Record<string, unknown>>[];
  readonly validation: readonly Readonly<Record<string, unknown>>[];
  readonly jobs: readonly Readonly<Record<string, unknown>>[];
  readonly health: readonly Readonly<Record<string, unknown>>[];
  readonly service: Readonly<Record<string, unknown>>;
  readonly git: Readonly<Record<string, unknown>>;
  readonly logs: Readonly<Record<string, unknown>>;
}

function systemPrincipal(projectId: string, permissions: readonly ProjectPermission[]): Principal {
  return { id: 'recovery-evidence', kind: 'system', projectScopes: [projectId], permissions };
}

function safeReason(error: unknown): string {
  const safe = redactError(error);
  return typeof safe['message'] === 'string' ? safe['message'] : 'Evidence source unavailable';
}

export class RecoveryEvidenceCollector {
  public constructor(
    private readonly db: SqliteDatabase,
    private readonly projects: ProjectStore,
    private readonly authorizer: Authorizer,
    private readonly tasks: TaskEngine,
    private readonly deployments: DeploymentEngine,
    private readonly git: GitService,
    private readonly logs?: JournalLogReader,
    private readonly services?: ProjectServiceManager,
  ) {}

  public async collect(taskId: string, projectId: string, principal: Principal): Promise<RecoveryEvidence> {
    this.authorizer.assertAllowed(principal, 'recovery:read', projectId);
    const project = this.projects.get(projectId);
    if (project === null || !project.enabled) throw new ValidationError('Project is not available');
    if (!project.permissions.includes('recovery:read')) throw new AuthorizationError('Project does not permit recovery evidence access');
    const task = this.tasks.get(taskId);
    if (task === null || task.projectId !== projectId) throw new ValidationError('Task is not available for this project');

    const deployment = task.deploymentId === null ? null : this.deployments.get(task.deploymentId);
    const operations = this.db.raw.prepare('SELECT operation_id,operation_type,status,target_id,created_at,started_at,finished_at,error_json FROM persistent_operations WHERE task_id=? AND project_id=? ORDER BY created_at DESC LIMIT 5').all(taskId, projectId) as Array<{operation_id:string;operation_type:string;status:string;target_id:string|null;created_at:string;started_at:string;finished_at:string|null;error_json:string|null}>;
    const validations = this.db.raw.prepare('SELECT attempt,finished_at,passed,result_json FROM validation_runs WHERE task_id=? AND project_id=? ORDER BY attempt DESC LIMIT 3').all(taskId, projectId) as Array<{attempt:number;finished_at:string;passed:number;result_json:string}>;
    const jobs = this.db.raw.prepare('SELECT job_id,command_id,status,exit_code,error_json,started_at,finished_at FROM jobs WHERE task_id=? AND project_id=? ORDER BY COALESCE(started_at,finished_at) DESC LIMIT 5').all(taskId, projectId) as Array<{job_id:string;command_id:string;status:string;exit_code:number|null;error_json:string|null;started_at:string|null;finished_at:string|null}>;
    const health = this.db.raw.prepare('SELECT checked_at,state,result_json FROM health_checks WHERE task_id=? AND project_id=? ORDER BY checked_at DESC LIMIT 3').all(taskId, projectId) as Array<{checked_at:string;state:string;result_json:string}>;

    const internal = systemPrincipal(projectId, ['git:read', 'logs:read', 'service:read']);
    let gitEvidence: Readonly<Record<string, unknown>> = { available: false };
    if (project.permissions.includes('git:read')) {
      try {
        const [status, head, diffStat] = await Promise.all([
          this.git.status(projectId, internal),
          this.git.headCommit(projectId, internal),
          this.git.diffStat(projectId, internal),
        ]);
        gitEvidence = { available: true, status: status.stdout, head: head.stdout.trim(), diffStat: diffStat.stdout };
      } catch (error) {
        gitEvidence = { available: false, reason: safeReason(error) };
      }
    }

    let serviceEvidence:Readonly<Record<string,unknown>>={available:false};
    if(this.services!==undefined&&project.permissions.includes('service:read')&&project.serviceName!==undefined){
      try{const snapshot=await this.services.status(projectId,internal);serviceEvidence={available:true,active:snapshot.active,state:snapshot.state,details:snapshot.details};}
      catch(error){serviceEvidence={available:false,reason:safeReason(error)};}
    }

    let logEvidence: Readonly<Record<string, unknown>> = { available: false };
    if (this.logs !== undefined && project.permissions.includes('logs:read') && project.serviceName !== undefined) {
      try {
        const result = await this.logs.read(projectId, internal, 80);
        logEvidence = { available: true, text: result.text.slice(0, 32_768), truncated: result.truncated || result.text.length > 32_768, lineLimit: result.lineLimit };
      } catch (error) {
        logEvidence = { available: false, reason: safeReason(error) };
      }
    }

    const taskSummary = {
      status: task.status,
      currentStep: task.currentStep,
      checkpoint: task.checkpoint,
      completedSteps: task.completedSteps,
      remainingSteps: task.remainingSteps,
      resumable: task.resumable,
      gitCommitBefore: task.gitCommitBefore,
      gitCommitAfter: task.gitCommitAfter,
      deploymentId: task.deploymentId,
      healthCheckResults: task.healthCheckResults,
      rollbackState: task.rollbackState,
      recoveryAttempts: task.recoveryAttempts,
      lastError: task.lastError,
    };
    const deploymentSummary = deployment === null ? null : {
      deploymentId: deployment.deploymentId,
      status: deployment.status,
      gitCommitBefore: deployment.gitCommitBefore,
      gitCommitAfter: deployment.gitCommitAfter,
      healthCheck: deployment.healthCheck,
      rollbackAvailable: deployment.rollbackAvailable,
      error: deployment.error,
      endTime: deployment.endTime,
    };

    return redactValue({
      projectId,
      taskId,
      collectedAt: new Date().toISOString(),
      task: taskSummary,
      deployment: deploymentSummary,
      operations: operations.map((row)=>({operationId:row.operation_id,type:row.operation_type,status:row.status,targetId:row.target_id,createdAt:row.created_at,startedAt:row.started_at,finishedAt:row.finished_at,error:row.error_json===null?null:JSON.parse(row.error_json) as unknown})),
      validation: validations.map((row) => ({ attempt: row.attempt, finishedAt: row.finished_at, passed: row.passed === 1, result: JSON.parse(row.result_json) as unknown })),
      jobs: jobs.map((row) => ({ jobId: row.job_id, commandId: row.command_id, status: row.status, exitCode: row.exit_code, error: row.error_json === null ? null : JSON.parse(row.error_json) as unknown, startedAt: row.started_at, finishedAt: row.finished_at })),
      health: health.map((row) => ({ checkedAt: row.checked_at, state: row.state, result: JSON.parse(row.result_json) as unknown })),
      service: serviceEvidence,
      git: gitEvidence,
      logs: logEvidence,
    }) as unknown as RecoveryEvidence;
  }
}

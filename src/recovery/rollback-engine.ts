import { randomUUID } from 'node:crypto';
import type { Authorizer, ProjectStore } from '../core/interfaces.js';
import type { MigrationRollbackSafety, Principal, ProjectPermission, ProjectRecord, RollbackStatus } from '../core/types.js';
import { AuthorizationError, HealthCheckError, RollbackBlockedError, ValidationError } from '../core/errors.js';
import type { SqliteDatabase } from '../database/sqlite.js';
import type { DatabaseAdapterFactory } from '../database/database-service.js';
import type { DatabaseMigrationStatus } from '../database/adapter.js';
import { DeploymentEngine } from '../deployment/deployment-engine.js';
import { GitService } from '../git/git-service.js';
import { RestrictedCommandRunner } from '../commands/command-runner.js';
import { TaskEngine } from '../tasks/task-engine.js';
import { HealthCheckService, type HealthCheckResult } from '../health/health-service.js';
import type { ServiceController, ServiceSnapshot } from '../services/service-controller.js';
import { redactError, redactValue } from '../security/redaction.js';
import { assessMigrationRollback, type MigrationRollbackAssessment } from './migration-safety.js';

export interface RollbackPlan {
  readonly rollbackId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly deploymentId: string;
  readonly targetCommit: string | null;
  readonly observedCommit: string | null;
  readonly status: RollbackStatus;
  readonly codeAction: 'configured-command' | 'manual';
  readonly databaseSafety: MigrationRollbackSafety;
  readonly migrationEvidence: MigrationRollbackAssessment;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly result: unknown;
  readonly error: unknown;
}

type Row = {
  rollback_id:string;task_id:string;project_id:string;deployment_id:string;target_commit:string|null;observed_commit:string|null;
  status:RollbackStatus;code_action:string;database_safety:MigrationRollbackSafety;migration_evidence_json:string;evidence_json:string;
  created_at:string;started_at:string|null;finished_at:string|null;result_json:string|null;error_json:string|null;
};

function parse(value: string | null): unknown { return value === null ? null : JSON.parse(value) as unknown; }
function map(row: Row): RollbackPlan {
  return {
    rollbackId: row.rollback_id,
    taskId: row.task_id,
    projectId: row.project_id,
    deploymentId: row.deployment_id,
    targetCommit: row.target_commit,
    observedCommit: row.observed_commit,
    status: row.status,
    codeAction: row.code_action === 'configured-command' ? 'configured-command' : 'manual',
    databaseSafety: row.database_safety,
    migrationEvidence: parse(row.migration_evidence_json) as MigrationRollbackAssessment,
    evidence: parse(row.evidence_json) as Readonly<Record<string, unknown>>,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    result: parse(row.result_json),
    error: parse(row.error_json),
  };
}

function systemPrincipal(projectId: string, permissions: readonly ProjectPermission[]): Principal {
  return { id: 'rollback-engine', kind: 'system', projectScopes: [projectId], permissions };
}

function lines(value: string): readonly string[] { return value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0); }
function cleanStatus(status: string): boolean {
  const all = lines(status);
  return all.length === 0 || (all.length === 1 && all[0]?.startsWith('##') === true);
}

function migrationFromRollbackState(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return (value as Readonly<Record<string, unknown>>)['migrationStatus'] ?? null;
}

export class RollbackEngine {
  public constructor(
    private readonly db: SqliteDatabase,
    private readonly projects: ProjectStore,
    private readonly authorizer: Authorizer,
    private readonly deployments: DeploymentEngine,
    private readonly git: GitService,
    private readonly runner: RestrictedCommandRunner,
    private readonly tasks: TaskEngine,
    private readonly health: HealthCheckService,
    private readonly services: ServiceController,
    private readonly databases: DatabaseAdapterFactory,
  ) {}

  public get(rollbackId: string): RollbackPlan | null {
    const row = this.db.raw.prepare('SELECT * FROM rollback_plans WHERE rollback_id=?').get(rollbackId) as Row | undefined;
    return row === undefined ? null : map(row);
  }

  public list(taskId: string): readonly RollbackPlan[] {
    return (this.db.raw.prepare('SELECT * FROM rollback_plans WHERE task_id=? ORDER BY created_at DESC').all(taskId) as Row[]).map(map);
  }

  public async plan(taskId: string, projectId: string, principal: Principal): Promise<RollbackPlan> {
    this.assertAllowed(projectId, principal);
    const project = this.getProject(projectId);
    const task = this.tasks.get(taskId);
    if (task === null || task.projectId !== projectId) throw new ValidationError('Task is not available for this project');
    if (task.deploymentId === null) throw new ValidationError('Task has no deployment to roll back');
    const deployment = this.deployments.get(task.deploymentId);
    if (deployment === null || deployment.projectId !== projectId) throw new ValidationError('Deployment record is not available');

    const internal = systemPrincipal(projectId, ['git:read', 'database:read']);
    const statusResult = await this.git.status(projectId, internal);
    const clean = cleanStatus(statusResult.stdout);
    const observedCommit = (await this.git.headCommit(projectId, internal)).stdout.trim() || null;
    const currentMigration = await this.currentMigration(project);
    const migration = assessMigrationRollback(project.database.adapter, migrationFromRollbackState(task.rollbackState), currentMigration);
    const reasons: string[] = [];
    if (!deployment.rollbackAvailable || deployment.gitCommitBefore === null) reasons.push('No last-known-good Git reference is available');
    else if (!(await this.git.commitExists(projectId, internal, deployment.gitCommitBefore))) reasons.push('Last-known-good Git reference is not present in the project repository');
    if (!clean) reasons.push('Git working tree contains uncommitted work');
    if (deployment.gitCommitAfter !== null && observedCommit !== deployment.gitCommitAfter) reasons.push('Current Git HEAD no longer matches the deployed commit');
    if (migration.safety !== 'SAFE') reasons.push(migration.reason);
    if (project.commands.rollback === undefined || project.commands.rollback.length === 0) reasons.push('No explicit rollback command is registered for the project');
    else if (!project.commands.rollback.some((argument) => argument.includes('{target_commit}'))) reasons.push('Rollback command does not explicitly reference {target_commit}');
    if (!project.permissions.includes('commands:run')) reasons.push('Project does not permit configured command execution');
    if (project.deployment.healthRequired && !project.permissions.includes('health:read')) reasons.push('Project does not permit the required post-rollback health check');

    const codeAction: 'configured-command' | 'manual' = project.commands.rollback === undefined || project.commands.rollback.length === 0 ? 'manual' : 'configured-command';
    const rollbackId = randomUUID();
    const createdAt = new Date().toISOString();
    const planStatus: RollbackStatus = reasons.length === 0 ? 'READY' : 'BLOCKED';
    const evidence = redactValue({ clean, gitStatus: statusResult.stdout, observedCommit, expectedDeployedCommit: deployment.gitCommitAfter, reasons });
    this.db.raw.prepare('INSERT INTO rollback_plans(rollback_id,task_id,project_id,deployment_id,target_commit,observed_commit,status,code_action,database_safety,migration_evidence_json,evidence_json,created_at,started_at,finished_at,result_json,error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(rollbackId, taskId, projectId, deployment.deploymentId, deployment.gitCommitBefore, observedCommit, planStatus, codeAction, migration.safety, JSON.stringify(redactValue(migration)), JSON.stringify(evidence), createdAt, null, null, null, null);
    this.tasks.setRollbackState(taskId, { rollbackId, status: planStatus, targetCommit: deployment.gitCommitBefore, migration });
    if (planStatus === 'BLOCKED') this.tasks.setStatus(taskId, 'WAITING_FOR_USER');
    else this.tasks.setStatus(taskId, 'ROLLBACK_REQUIRED');
    return this.getRequired(rollbackId);
  }

  public async execute(rollbackId: string, projectId: string, principal: Principal): Promise<RollbackPlan> {
    this.assertAllowed(projectId, principal);
    const plan = this.getRequired(rollbackId);
    if (plan.projectId !== projectId) throw new ValidationError('Rollback plan is not available for this project');
    if (plan.status !== 'READY') throw new RollbackBlockedError('Only a READY rollback plan can execute');
    const project = this.getProject(projectId);
    const internal = systemPrincipal(projectId, ['git:read', 'commands:run', 'health:read', 'database:read']);
    await this.revalidate(plan, project, internal);

    const startedAt = new Date().toISOString();
    this.db.raw.prepare("UPDATE rollback_plans SET status='ROLLING_BACK',started_at=? WHERE rollback_id=?").run(startedAt, rollbackId);
    this.tasks.setStatus(plan.taskId, 'ROLLING_BACK');
    this.tasks.checkpoint(plan.taskId, { currentStep: 'rollback', completedSteps: [], remainingSteps: ['rollback', 'git-verification', 'service-verification', 'health-check'], metadata: { rollbackId, targetCommit: plan.targetCommit } });

    try {
      if (plan.targetCommit === null) throw new RollbackBlockedError('Rollback target is unavailable');
      const command = await this.runner.runRollback(projectId, internal, plan.targetCommit);
      const commandSummary = { id: 'rollback', exitCode: command.exitCode, durationMs: command.durationMs, truncated: command.stdoutTruncated || command.stderrTruncated };
      this.tasks.recordCommand(plan.taskId, commandSummary);
      if (command.exitCode !== 0) throw new ValidationError('Rollback command failed', { exitCode: command.exitCode, stderr: command.stderr });

      const headAfter = (await this.git.headCommit(projectId, internal)).stdout.trim() || null;
      if (headAfter !== plan.targetCommit) throw new RollbackBlockedError('Rollback command completed but Git HEAD does not match the target commit');
      this.tasks.setGitReferences(plan.taskId, plan.targetCommit, headAfter);

      if (project.deployment.restartService && project.serviceName !== undefined) await this.services.restart(project.serviceName);
      let serviceSnapshot:ServiceSnapshot|null=null;
      if(project.serviceName!==undefined){
        serviceSnapshot=await this.services.status(project.serviceName);
        this.tasks.recordCommand(plan.taskId,{id:'service-status',service:project.serviceName,active:serviceSnapshot.active,state:serviceSnapshot.state});
        if(!serviceSnapshot.active)throw new HealthCheckError(`Post-rollback service state is ${serviceSnapshot.state}`);
      }

      let health: HealthCheckResult | null = null;
      if (project.health.type !== 'none') {
        this.db.raw.prepare("UPDATE rollback_plans SET status='HEALTH_CHECKING' WHERE rollback_id=?").run(rollbackId);
        this.tasks.setStatus(plan.taskId, 'HEALTH_CHECKING');
        health = await this.health.check(projectId, internal, { taskId: plan.taskId, deploymentId: plan.deploymentId });
        this.tasks.setHealthResult(plan.taskId, health);
        if (project.deployment.healthRequired && health.state !== 'HEALTHY') throw new HealthCheckError(`Post-rollback health is ${health.state}`);
      }
      const finishedAt = new Date().toISOString();
      const result = redactValue({ ok: true, command: commandSummary, health, service:serviceSnapshot, headAfter, targetCommit: plan.targetCommit, targetVerified:true });
      this.db.raw.prepare("UPDATE rollback_plans SET status='SUCCEEDED',finished_at=?,result_json=? WHERE rollback_id=?").run(finishedAt, JSON.stringify(result), rollbackId);
      this.tasks.setRollbackState(plan.taskId, { rollbackId, status: 'SUCCEEDED', targetCommit: plan.targetCommit, health, service:serviceSnapshot, headAfter, targetVerified:true });
      this.tasks.checkpoint(plan.taskId, { currentStep: 'rolled-back', completedSteps: ['rollback','git-verification', ...(serviceSnapshot === null ? [] : ['service-verification']), ...(health === null ? [] : ['health-check'])], remainingSteps: [], metadata: { rollbackId, headAfter, targetVerified:true } });
      this.tasks.setStatus(plan.taskId, 'ROLLED_BACK');
      return this.getRequired(rollbackId);
    } catch (error) {
      const safe = redactError(error);
      const finishedAt = new Date().toISOString();
      this.db.raw.prepare("UPDATE rollback_plans SET status='FAILED',finished_at=?,error_json=? WHERE rollback_id=?").run(finishedAt, JSON.stringify(safe), rollbackId);
      this.tasks.setRollbackState(plan.taskId, { rollbackId, status: 'FAILED', error: safe });
      this.tasks.recordError(plan.taskId, safe);
      this.tasks.setStatus(plan.taskId, 'WAITING_FOR_USER');
      return this.getRequired(rollbackId);
    }
  }

  private async revalidate(plan: RollbackPlan, project: ProjectRecord, principal: Principal): Promise<void> {
    const status = await this.git.status(project.id, principal);
    if (!cleanStatus(status.stdout)) {
      this.block(plan.rollbackId, 'Git working tree changed after rollback planning');
      throw new RollbackBlockedError('Git working tree changed after rollback planning');
    }
    const head = (await this.git.headCommit(project.id, principal)).stdout.trim() || null;
    if (head !== plan.observedCommit) {
      this.block(plan.rollbackId, 'Git HEAD changed after rollback planning');
      throw new RollbackBlockedError('Git HEAD changed after rollback planning');
    }
    const currentMigration = await this.currentMigration(project);
    const migration = assessMigrationRollback(project.database.adapter, plan.migrationEvidence.before, currentMigration);
    if (migration.safety !== 'SAFE') {
      this.block(plan.rollbackId, migration.reason);
      throw new RollbackBlockedError(migration.reason);
    }
  }

  private async currentMigration(project: ProjectRecord): Promise<DatabaseMigrationStatus | Readonly<Record<string, unknown>> | null> {
    if (project.database.adapter === 'none') return null;
    try {
      const adapter = await this.databases.create(project);
      try { return await adapter.migrationStatus(5_000); } finally { await adapter.close(); }
    } catch (error) {
      return { known: false, system: null, current: null, pending: null, details: { error: redactError(error) } };
    }
  }

  private block(rollbackId: string, reason: string): void {
    this.db.raw.prepare("UPDATE rollback_plans SET status='BLOCKED',error_json=? WHERE rollback_id=?").run(JSON.stringify({ message: reason }), rollbackId);
  }

  private assertAllowed(projectId: string, principal: Principal): void {
    this.authorizer.assertAllowed(principal, 'rollback:run', projectId);
    const project = this.getProject(projectId);
    if (!project.permissions.includes('rollback:run')) throw new AuthorizationError('Project does not permit rollback');
  }

  private getProject(projectId: string): ProjectRecord {
    const project = this.projects.get(projectId);
    if (project === null || !project.enabled) throw new ValidationError('Project is not available');
    return project;
  }

  private getRequired(rollbackId: string): RollbackPlan {
    const plan = this.get(rollbackId);
    if (plan === null) throw new ValidationError('Rollback plan not found');
    return plan;
  }
}

import process from 'node:process';
import type { ProjectStore } from '../../core/interfaces.js';
import type { ProjectPermission } from '../../core/types.js';
import { AuthorizationError, ValidationError } from '../../core/errors.js';
import type { DatabaseParameter } from '../../database/adapter.js';
import type { DatabaseService } from '../../database/database-service.js';
import type { DeploymentEngine } from '../../deployment/deployment-engine.js';
import type { ProjectFileService } from '../../files/file-service.js';
import type { GitService } from '../../git/git-service.js';
import type { HealthCheckService } from '../../health/health-service.js';
import type { JobManager } from '../../jobs/job-manager.js';
import type { JournalLogReader } from '../../logs/journal-logs.js';
import type { PersistentOperationManager, PersistentOperationType } from '../../operations/persistent-operation.js';
import type { RecoveryEngine } from '../../recovery/recovery-engine.js';
import type { RollbackEngine } from '../../recovery/rollback-engine.js';
import type { ProjectServiceManager } from '../../services/service-controller.js';
import type { TaskEngine } from '../../tasks/task-engine.js';
import type { LocalValidationPipeline } from '../../validation/local-ci.js';
import { numberArg, objectArg, stringArg, stringArrayArg } from '../arguments.js';
import type { McpToolRegistry } from '../tool-registry.js';
import { registerFileTools } from './file-tools.js';
import { registerGitCommandTools } from './git-command-tools.js';
import { registerProjectTools } from './project-tools.js';
import { objectSchema, projectIdSchema, stringSchema } from './schema-helpers.js';

export interface ServerAgentMcpServices {
  readonly projects: ProjectStore;
  readonly files: ProjectFileService;
  readonly git: GitService;
  readonly jobs: JobManager;
  readonly operations: PersistentOperationManager;
  readonly validation: LocalValidationPipeline;
  readonly database: DatabaseService;
  readonly tasks: TaskEngine;
  readonly deployments: DeploymentEngine;
  readonly health: HealthCheckService;
  readonly logs: JournalLogReader;
  readonly services: ProjectServiceManager;
  readonly recovery: RecoveryEngine;
  readonly rollback: RollbackEngine;
}

function requireProjectCapability(services: ServerAgentMcpServices, projectId: string, permission: ProjectPermission): void {
  const project = services.projects.get(projectId);
  if (project === null || !project.enabled) throw new ValidationError('Project is not available');
  if (!project.permissions.includes(permission)) throw new AuthorizationError(`Project does not permit ${permission}`);
}

function taskForProject(services: ServerAgentMcpServices, projectId: string, taskId: string) {
  const task = services.tasks.get(taskId);
  if (task === null || task.projectId !== projectId) throw new ValidationError('Task is not available for this project');
  return task;
}

function jobForProject(services: ServerAgentMcpServices, projectId: string, jobId: string) {
  const job = services.jobs.get(jobId);
  if (job === null || job.projectId !== projectId) throw new ValidationError('Job is not available for this project');
  return job;
}

function operationForProject(services:ServerAgentMcpServices,projectId:string,operationId:string,type:PersistentOperationType){
  const operation=services.operations.get(operationId);
  if(operation===null||operation.projectId!==projectId||operation.type!==type)throw new ValidationError(`${type.toLowerCase()} operation is not available for this project`);
  return operation;
}

function deploymentForProject(services: ServerAgentMcpServices, projectId: string, deploymentId: string) {
  const deployment = services.deployments.get(deploymentId);
  if (deployment === null || deployment.projectId !== projectId) throw new ValidationError('Deployment is not available for this project');
  return deployment;
}

function recoveryForProject(services: ServerAgentMcpServices, projectId: string, recoveryId: string) {
  const recovery = services.recovery.get(recoveryId);
  if (recovery === null || recovery.projectId !== projectId) throw new ValidationError('Recovery run is not available for this project');
  return recovery;
}

function rollbackForProject(services: ServerAgentMcpServices, projectId: string, rollbackId: string) {
  const rollback = services.rollback.get(rollbackId);
  if (rollback === null || rollback.projectId !== projectId) throw new ValidationError('Rollback plan is not available for this project');
  return rollback;
}

function databaseParams(value: unknown, name = 'params'): readonly DatabaseParameter[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${name} must be an array`);
  if (value.length > 500) throw new ValidationError(`${name} exceeds the allowed length`);
  return value.map((item, index) => {
    if (item === null || typeof item === 'string' || typeof item === 'number') return item;
    throw new ValidationError(`${name}[${index}] must be string, number, or null`);
  });
}

function transactionStatements(value: unknown): readonly { sql: string; params?: readonly DatabaseParameter[] }[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) throw new ValidationError('statements must contain 1-50 entries');
  return value.map((item, index) => {
    const row = objectArg(item, `statements[${index}]`);
    const sql = row['sql'];
    if (typeof sql !== 'string' || sql.trim() === '' || sql.length > 100_000) throw new ValidationError(`statements[${index}].sql is invalid`);
    const params = databaseParams(row['params'], `statements[${index}].params`);
    return params.length === 0 ? { sql } : { sql, params };
  });
}

function registerTaskTools(registry: McpToolRegistry, services: ServerAgentMcpServices): void {
  registry.register({
    definition: { name: 'create_task', description: 'Create a persistent project task.', inputSchema: objectSchema({ project_id: projectIdSchema, title: stringSchema, remaining_steps: { type: 'array', items: { type: 'string' }, maxItems: 256 } }, ['project_id', 'title']) },
    permission: 'tasks:write', projectArgument: 'project_id',
    handler: async (args) => { const projectId = stringArg(args, 'project_id') ?? ''; requireProjectCapability(services, projectId, 'tasks:write'); return services.tasks.create(projectId, stringArg(args, 'title', { max: 512 }) ?? '', stringArrayArg(args, 'remaining_steps', true) ?? []); },
  });
  registry.register({
    definition: { name: 'task_status', description: 'Get one persistent task.', inputSchema: objectSchema({ project_id: projectIdSchema, task_id: stringSchema }, ['project_id', 'task_id']) },
    permission: 'tasks:read', projectArgument: 'project_id',
    handler: async (args) => { const projectId = stringArg(args, 'project_id') ?? ''; requireProjectCapability(services, projectId, 'tasks:read'); return taskForProject(services, projectId, stringArg(args, 'task_id', { max: 128 }) ?? ''); },
  });
  registry.register({
    definition: { name: 'list_tasks', description: 'List tasks for one project.', inputSchema: objectSchema({ project_id: projectIdSchema }, ['project_id']) },
    permission: 'tasks:read', projectArgument: 'project_id',
    handler: async (args) => { const projectId = stringArg(args, 'project_id') ?? ''; requireProjectCapability(services, projectId, 'tasks:read'); return services.tasks.list(projectId); },
  });
  for (const action of ['resume', 'pause', 'cancel'] as const) {
    registry.register({
      definition: { name: `${action}_task`, description: `${action} a persistent project task.`, inputSchema: objectSchema({ project_id: projectIdSchema, task_id: stringSchema }, ['project_id', 'task_id']) },
      permission: 'tasks:write', projectArgument: 'project_id',
      handler: async (args) => {
        const projectId = stringArg(args, 'project_id') ?? '';
        requireProjectCapability(services, projectId, 'tasks:write');
        const taskId = stringArg(args, 'task_id', { max: 128 }) ?? '';
        taskForProject(services, projectId, taskId);
        return action === 'resume' ? services.tasks.resume(taskId) : action === 'pause' ? services.tasks.pause(taskId) : services.tasks.cancel(taskId);
      },
    });
  }
}

function registerJobTools(registry: McpToolRegistry, services: ServerAgentMcpServices): void {
  registry.register({
    definition: { name: 'job_status', description: 'Read one persistent command job after disconnect or process restart.', inputSchema: objectSchema({ project_id: projectIdSchema, job_id: stringSchema }, ['project_id', 'job_id']) },
    permission: 'commands:run', projectArgument: 'project_id',
    handler: async (args) => { const projectId = stringArg(args, 'project_id') ?? ''; requireProjectCapability(services, projectId, 'commands:run'); return jobForProject(services, projectId, stringArg(args, 'job_id', { max: 128 }) ?? ''); },
  });
  registry.register({
    definition: { name: 'list_jobs', description: 'List recent persistent command jobs for one project.', inputSchema: objectSchema({ project_id: projectIdSchema }, ['project_id']) },
    permission: 'commands:run', projectArgument: 'project_id',
    handler: async (args) => { const projectId = stringArg(args, 'project_id') ?? ''; requireProjectCapability(services, projectId, 'commands:run'); return services.jobs.list(projectId).slice(0, 100); },
  });
  registry.register({
    definition: { name: 'cancel_job', description: 'Cancel a running job only when it is attached to this Agent process.', inputSchema: objectSchema({ project_id: projectIdSchema, job_id: stringSchema }, ['project_id', 'job_id']) },
    permission: 'commands:run', projectArgument: 'project_id',
    handler: async (args) => { const projectId = stringArg(args, 'project_id') ?? ''; requireProjectCapability(services, projectId, 'commands:run'); const jobId = stringArg(args, 'job_id', { max: 128 }) ?? ''; jobForProject(services, projectId, jobId); return services.jobs.cancel(jobId); },
  });
}

function registerDatabaseTools(registry: McpToolRegistry, services: ServerAgentMcpServices): void {
  registry.register({ definition: { name: 'database_status', description: 'Check configured project database connectivity.', inputSchema: objectSchema({ project_id: projectIdSchema }, ['project_id']) }, permission: 'database:read', projectArgument: 'project_id', handler: async (args, ctx) => services.database.status(stringArg(args, 'project_id') ?? '', ctx.principal) });
  registry.register({ definition: { name: 'database_schema', description: 'Read bounded project database schema metadata.', inputSchema: objectSchema({ project_id: projectIdSchema }, ['project_id']) }, permission: 'database:read', projectArgument: 'project_id', handler: async (args, ctx) => services.database.schema(stringArg(args, 'project_id') ?? '', ctx.principal) });
  registry.register({ definition: { name: 'database_migration_status', description: 'Read project migration status without applying migrations.', inputSchema: objectSchema({ project_id: projectIdSchema }, ['project_id']) }, permission: 'database:read', projectArgument: 'project_id', handler: async (args, ctx) => services.database.migrationStatus(stringArg(args, 'project_id') ?? '', ctx.principal) });
  registry.register({
    definition: { name: 'database_query', description: 'Run one classified, bounded, non-destructive database query.', inputSchema: objectSchema({ project_id: projectIdSchema, sql: stringSchema, params: { type: 'array', maxItems: 500 } }, ['project_id', 'sql']) },
    permission: 'database:read', projectArgument: 'project_id',
    handler: async (args, ctx) => services.database.query(stringArg(args, 'project_id') ?? '', ctx.principal, stringArg(args, 'sql', { max: 100_000 }) ?? '', databaseParams(args['params'])),
  });
  registry.register({
    definition: { name: 'database_transaction', description: 'Run 1-50 classified, non-destructive statements in one controlled transaction.', inputSchema: objectSchema({ project_id: projectIdSchema, statements: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object' } } }, ['project_id', 'statements']) },
    permission: 'database:read', projectArgument: 'project_id',
    handler: async (args, ctx) => services.database.transaction(stringArg(args, 'project_id') ?? '', ctx.principal, transactionStatements(args['statements'])),
  });
}

function registerOperationalTools(registry: McpToolRegistry, services: ServerAgentMcpServices): void {
  registry.register({ definition: { name: 'get_logs', description: 'Read bounded journal logs for the registered project service.', inputSchema: objectSchema({ project_id: projectIdSchema, lines: { type: 'number', minimum: 1, maximum: 2000 } }, ['project_id']) }, permission: 'logs:read', projectArgument: 'project_id', handler: async (args, ctx) => services.logs.read(stringArg(args, 'project_id') ?? '', ctx.principal, numberArg(args, 'lines', { optional: true, min: 1, max: 2000 }) ?? 200) });
  registry.register({ definition: { name: 'service_status', description: 'Read the registered project service status.', inputSchema: objectSchema({ project_id: projectIdSchema }, ['project_id']) }, permission: 'service:read', projectArgument: 'project_id', handler: async (args, ctx) => services.services.status(stringArg(args, 'project_id') ?? '', ctx.principal) });
  registry.register({ definition: { name: 'service_restart', description: 'Restart only the registered project service.', inputSchema: objectSchema({ project_id: projectIdSchema }, ['project_id']) }, permission: 'service:restart', projectArgument: 'project_id', handler: async (args, ctx) => { await services.services.restart(stringArg(args, 'project_id') ?? '', ctx.principal); return { ok: true }; } });
  registry.register({ definition: { name: 'health_check', description: 'Run the configured project health check.', inputSchema: objectSchema({ project_id: projectIdSchema }, ['project_id']) }, permission: 'health:read', projectArgument: 'project_id', handler: async (args, ctx) => services.health.check(stringArg(args, 'project_id') ?? '', ctx.principal) });
  registry.register({ definition: { name: 'deploy', description: 'Start guarded deployment as a durable operation and return operation_id immediately.', inputSchema: objectSchema({ project_id: projectIdSchema, task_id: stringSchema }, ['project_id', 'task_id']) }, permission: 'deploy:run', projectArgument: 'project_id', handler: async (args, ctx) => {
    const projectId=stringArg(args,'project_id')??'',taskId=stringArg(args,'task_id',{max:128})??'';taskForProject(services,projectId,taskId);
    return services.operations.start('DEPLOYMENT',projectId,taskId,async()=>{const result=await services.deployments.deploy(taskId,projectId,ctx.principal);return result.status==='SUCCEEDED'?{targetId:result.deploymentId,result}:{targetId:result.deploymentId,result,succeeded:false,error:result.error??{message:`Deployment ended in ${result.status}`}};});
  } });
  registry.register({ definition: { name: 'deployment_operation_status', description: 'Read one durable deployment operation.', inputSchema: objectSchema({ project_id: projectIdSchema, operation_id: stringSchema }, ['project_id','operation_id']) }, permission: 'deploy:read', projectArgument: 'project_id', handler: async (args) => operationForProject(services,stringArg(args,'project_id')??'',stringArg(args,'operation_id',{max:128})??'','DEPLOYMENT') });
  registry.register({ definition: { name: 'deployment_status', description: 'Read one deployment or list project deployments.', inputSchema: objectSchema({ project_id: projectIdSchema, deployment_id: stringSchema }, ['project_id']) }, permission: 'deploy:read', projectArgument: 'project_id', handler: async (args) => { const projectId = stringArg(args, 'project_id') ?? ''; requireProjectCapability(services, projectId, 'deploy:read'); const id = stringArg(args, 'deployment_id', { optional: true, max: 128 }); return id === undefined ? services.deployments.list(projectId) : deploymentForProject(services, projectId, id); } });
}

function registerRecoveryTools(registry: McpToolRegistry, services: ServerAgentMcpServices): void {
  registry.register({ definition: { name: 'recovery_assess', description: 'Collect evidence and produce a bounded recovery decision. Mutating work is never replayed automatically.', inputSchema: objectSchema({ project_id: projectIdSchema, task_id: stringSchema, reason: stringSchema }, ['project_id', 'task_id']) }, permission: 'recovery:run', projectArgument: 'project_id', handler: async (args, ctx) => services.recovery.assess(stringArg(args, 'task_id', { max: 128 }) ?? '', stringArg(args, 'project_id') ?? '', ctx.principal, stringArg(args, 'reason', { optional: true, max: 1000 }) ?? 'Recovery assessment requested') });
  registry.register({ definition: { name: 'recovery_status', description: 'Read recovery history for a project task.', inputSchema: objectSchema({ project_id: projectIdSchema, task_id: stringSchema, recovery_id: stringSchema }, ['project_id', 'task_id']) }, permission: 'recovery:read', projectArgument: 'project_id', handler: async (args) => { const projectId = stringArg(args, 'project_id') ?? ''; requireProjectCapability(services, projectId, 'recovery:read'); const taskId = stringArg(args, 'task_id', { max: 128 }) ?? ''; taskForProject(services, projectId, taskId); const id = stringArg(args, 'recovery_id', { optional: true, max: 128 }); return id === undefined ? services.recovery.list(taskId) : recoveryForProject(services, projectId, id); } });
  registry.register({ definition: { name: 'rollback_plan', description: 'Create and persist a rollback safety plan without executing it.', inputSchema: objectSchema({ project_id: projectIdSchema, task_id: stringSchema }, ['project_id', 'task_id']) }, permission: 'rollback:run', projectArgument: 'project_id', handler: async (args, ctx) => services.rollback.plan(stringArg(args, 'task_id', { max: 128 }) ?? '', stringArg(args, 'project_id') ?? '', ctx.principal) });
  registry.register({ definition: { name: 'rollback_status', description: 'Read rollback plans for a project task.', inputSchema: objectSchema({ project_id: projectIdSchema, task_id: stringSchema, rollback_id: stringSchema }, ['project_id', 'task_id']) }, permission: 'rollback:read', projectArgument: 'project_id', handler: async (args) => { const projectId = stringArg(args, 'project_id') ?? ''; requireProjectCapability(services, projectId, 'rollback:read'); const taskId = stringArg(args, 'task_id', { max: 128 }) ?? ''; taskForProject(services, projectId, taskId); const id = stringArg(args, 'rollback_id', { optional: true, max: 128 }); return id === undefined ? services.rollback.list(taskId) : rollbackForProject(services, projectId, id); } });
  registry.register({ definition: { name: 'rollback_execute', description: 'Start execution of a READY rollback plan as a durable operation after revalidation.', inputSchema: objectSchema({ project_id: projectIdSchema, rollback_id: stringSchema }, ['project_id', 'rollback_id']) }, permission: 'rollback:run', projectArgument: 'project_id', handler: async (args, ctx) => {
    const projectId=stringArg(args,'project_id')??'',rollbackId=stringArg(args,'rollback_id',{max:128})??'';const plan=rollbackForProject(services,projectId,rollbackId);
    return services.operations.start('ROLLBACK',projectId,plan.taskId,async()=>{const result=await services.rollback.execute(rollbackId,projectId,ctx.principal);return result.status==='SUCCEEDED'?{targetId:rollbackId,result}:{targetId:rollbackId,result,succeeded:false,error:result.error??{message:`Rollback ended in ${result.status}`}};});
  } });
  registry.register({ definition: { name: 'rollback_operation_status', description: 'Read one durable rollback execution operation.', inputSchema: objectSchema({ project_id: projectIdSchema, operation_id: stringSchema }, ['project_id','operation_id']) }, permission: 'rollback:read', projectArgument: 'project_id', handler: async (args) => operationForProject(services,stringArg(args,'project_id')??'',stringArg(args,'operation_id',{max:128})??'','ROLLBACK') });
}

function registerDiagnosticsTools(registry: McpToolRegistry, services: ServerAgentMcpServices): void {
  registry.register({
    definition: { name: 'system_snapshot', description: 'Return a bounded Server Agent process snapshot. Requires global project scope.', inputSchema: objectSchema({}) },
    permission: 'project:read', requiresGlobalScope: true,
    handler: async (_args, context) => ({
      process: { uptimeSeconds: Math.round(process.uptime()), rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed, node: process.version },
      visibleProjects: services.projects.list().filter((project) => project.permissions.includes('project:read') && (context.principal.projectScopes.includes('*') || context.principal.projectScopes.includes(project.id))).length,
    }),
  });
  registry.register({
    definition: { name: 'project_diagnostics', description: 'Return bounded registry/task/deployment diagnostics for one project without reading secrets.', inputSchema: objectSchema({ project_id: projectIdSchema }, ['project_id']) },
    permission: 'project:read', projectArgument: 'project_id',
    handler: async (args) => {
      const projectId = stringArg(args, 'project_id') ?? '';
      requireProjectCapability(services, projectId, 'project:read');
      const project = services.projects.get(projectId);
      if (project === null) throw new ValidationError('Project is not available');
      return { project: { id: project.id, name: project.name, enabled: project.enabled, runtime: project.runtime, serviceName: project.serviceName ?? null }, tasks: services.tasks.list(projectId).slice(0, 20), jobs: services.jobs.list(projectId).slice(0, 20), operations:services.operations.list(projectId).slice(0,20), deployments: services.deployments.list(projectId).slice(0, 20) };
    },
  });
}

export function registerServerAgentTools(registry: McpToolRegistry, services: ServerAgentMcpServices): void {
  registerProjectTools(registry, services.projects);
  registerFileTools(registry, services.files);
  registerGitCommandTools(registry, services.git, services.jobs, services.validation,services.operations);
  registerTaskTools(registry, services);
  registerJobTools(registry, services);
  registerDatabaseTools(registry, services);
  registerOperationalTools(registry, services);
  registerRecoveryTools(registry, services);
  registerDiagnosticsTools(registry, services);
}

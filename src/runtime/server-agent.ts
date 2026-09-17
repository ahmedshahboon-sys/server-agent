import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { loadConfig } from '../config/config.js';
import { SqliteDatabase } from '../database/sqlite.js';
import { DatabaseService, ProjectDatabaseAdapterFactory } from '../database/database-service.js';
import { StructuredLogger } from '../logging/logger.js';
import { ProjectRegistry } from '../projects/registry.js';
import { DefaultDenyAuthorizer } from '../security/authorization.js';
import { redactError } from '../security/redaction.js';
import { ProjectFileService } from '../files/file-service.js';
import { GitService } from '../git/git-service.js';
import { RestrictedCommandRunner } from '../commands/command-runner.js';
import { JobManager } from '../jobs/job-manager.js';
import { TaskEngine } from '../tasks/task-engine.js';
import { IdempotencyStore } from '../idempotency/idempotency.js';
import { OperationLeaseStore } from '../operations/operation-lease.js';
import { LocalValidationPipeline } from '../validation/local-ci.js';
import { SystemdServiceController, ProjectServiceManager } from '../services/service-controller.js';
import { JournalLogReader } from '../logs/journal-logs.js';
import { FetchHttpProbe, HealthCheckService } from '../health/health-service.js';
import { DeploymentEngine } from '../deployment/deployment-engine.js';
import { RecoveryEvidenceCollector } from '../recovery/evidence.js';
import { RecoveryEngine } from '../recovery/recovery-engine.js';
import { RollbackEngine } from '../recovery/rollback-engine.js';
import { StaticBearerAuthenticator } from '../mcp/auth.js';
import { createServerAgentMcpServer } from '../mcp/server.js';
import { loadRuntimeAuthentication } from './auth.js';

const SERVER_VERSION = '0.5.0';

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { server.off('listening', onListening); reject(error); };
    const onListening = (): void => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function runServerAgent(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadConfig(env);
  const authentication = loadRuntimeAuthentication(env);
  await mkdir(config.dataDir, { recursive: true, mode: 0o750 });
  await mkdir(path.dirname(config.dbPath), { recursive: true, mode: 0o750 });

  const logger = new StructuredLogger(config.logLevel);
  const db = new SqliteDatabase(config.dbPath);
  const runtimeInstanceId=randomUUID();
  const idempotency=new IdempotencyStore(db);
  const leases=new OperationLeaseStore(db);
  const reclaimedLeases=leases.reclaimExpired();
  const projects = new ProjectRegistry(db);
  const authorizer = new DefaultDenyAuthorizer();
  const files = new ProjectFileService(projects, authorizer, { maxFileBytes: config.maxFileBytes });
  const runner = new RestrictedCommandRunner(projects, authorizer, { timeoutMs: config.commandTimeoutMs, maxOutputBytes: config.maxCommandOutputBytes, environment: env });
  const tasks = new TaskEngine(db);
  const jobs = new JobManager(db,runner,config.dataDir,config.maxConcurrentJobs,{instanceId:runtimeInstanceId,idempotency,leases,leaseTtlMs:config.commandTimeoutMs+5_000});
  tasks.bindJobController(jobs);
  const git = new GitService(projects, authorizer, { timeoutMs: config.commandTimeoutMs, maxOutputBytes: config.maxCommandOutputBytes, environment: env });
  const validation = new LocalValidationPipeline(db, projects, runner, config.maxFixAttempts);
  const databaseFactory = new ProjectDatabaseAdapterFactory();
  const database = new DatabaseService(db, projects, authorizer, databaseFactory, { timeoutMs: config.databaseQueryTimeoutMs, maxRows: config.databaseMaxRows, maxResultBytes: config.databaseMaxResultBytes },{idempotency,leases,ownerId:runtimeInstanceId,leaseTtlMs:config.databaseQueryTimeoutMs+5_000});
  const serviceController = new SystemdServiceController(env);
  const services = new ProjectServiceManager(projects,authorizer,serviceController,{idempotency,leases,ownerId:runtimeInstanceId,leaseTtlMs:60_000});
  const logs = new JournalLogReader(projects, authorizer, env, config.maxLogOutputBytes);
  const health = new HealthCheckService(db, projects, authorizer, serviceController, new FetchHttpProbe(), databaseFactory);
  const deployments = new DeploymentEngine(db, projects, authorizer, git, runner, validation, tasks, health, serviceController, databaseFactory);
  const evidence = new RecoveryEvidenceCollector(db, projects, authorizer, tasks, deployments, git, logs);
  const recovery = new RecoveryEngine(db, projects, authorizer, tasks, deployments, evidence, config.maxRecoveryAttempts);
  const rollback = new RollbackEngine(db, projects, authorizer, deployments, git, runner, tasks, health, serviceController, databaseFactory);

  const interruptedTasks = tasks.markInterruptedForRecovery();
  const reconciledJobs = jobs.reconcileAfterRestart();
  if (interruptedTasks > 0 || reconciledJobs > 0 || reclaimedLeases > 0) logger.warn('Recovered interrupted runtime state', { interruptedTasks, reconciledJobs, reclaimedLeases });

  const server = createServerAgentMcpServer({
    authorizer,
    stateDatabase: db,
    authenticator: new StaticBearerAuthenticator(authentication.token, authentication.principal),
    services: { projects, files, git, jobs, validation, database, tasks, deployments, health, logs, services, recovery, rollback },
    transport: { path: config.mcpPath, maxBodyBytes: config.mcpMaxBodyBytes, allowedOrigins: config.mcpAllowedOrigins, serverName: 'server-agent', serverVersion: SERVER_VERSION },
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 100;

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Server Agent stopping', { signal });
    const serverClosed = close(server);
    await jobs.shutdown();
    await serverClosed;
    db.close();
    logger.info('Server Agent stopped');
  };
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });

  try {
    await listen(server, config.mcpPort, config.mcpHost);
    logger.info('Server Agent MCP listening', { host: config.mcpHost, port: config.mcpPort, path: config.mcpPath, principalId: authentication.principal.id, projectScopeCount: authentication.principal.projectScopes.length });
  } catch (error) {
    db.close();
    throw error;
  }
}

async function main(): Promise<void> {
  try { await runServerAgent(); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ level: 'error', message: 'Server Agent startup failed', error: redactError(error) })}\n`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) void main();

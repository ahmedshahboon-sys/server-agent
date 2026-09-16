import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { TaskEngine } from '../../src/tasks/task-engine.js';
import { RollbackEngine } from '../../src/recovery/rollback-engine.js';
import type { DeploymentEngine, DeploymentRecord } from '../../src/deployment/deployment-engine.js';
import type { GitService } from '../../src/git/git-service.js';
import type { RestrictedCommandRunner } from '../../src/commands/command-runner.js';
import type { HealthCheckService } from '../../src/health/health-service.js';
import type { ServiceController } from '../../src/services/service-controller.js';
import type { DatabaseAdapterFactory } from '../../src/database/database-service.js';
import { projectFixture } from '../helpers.js';

const before = '1111111111111111111111111111111111111111';
const after = '2222222222222222222222222222222222222222';

test('failed deployment rollback remains BLOCKED when no explicit rollback command is registered', async () => {
  const db = new SqliteDatabase(':memory:');
  try {
    const projects = new ProjectRegistry(db);
    projects.create(projectFixture({
      permissions: ['project:read', 'git:read', 'commands:run', 'rollback:read', 'rollback:run'],
      commands: {},
      health: { type: 'none' },
      database: { adapter: 'none', defaultAccess: 'read' },
      deployment: { strategy: 'none', requireClean: true, validationRequired: false, restartService: false, healthRequired: false },
      environmentRefs: [],
    }));
    const tasks = new TaskEngine(db);
    const task = tasks.create('project-a', 'failed deploy');
    tasks.setDeployment(task.taskId, 'deployment-1');
    tasks.setGitReferences(task.taskId, before, after);
    const deployment: DeploymentRecord = {
      deploymentId: 'deployment-1', taskId: task.taskId, projectId: 'project-a', status: 'FAILED', gitCommitBefore: before, gitCommitAfter: after,
      filesChanged: [], commands: [], startTime: new Date().toISOString(), endTime: new Date().toISOString(), service: null, healthCheck: null,
      precheck: {}, result: null, rollbackAvailable: true, error: { message: 'deploy failed' },
    };
    const deployments = { get: (id: string) => id === 'deployment-1' ? deployment : null } as unknown as DeploymentEngine;
    const git = {
      async status() { return { stdout: '', stderr: '', exitCode: 0 }; },
      async headCommit() { return { stdout: `${after}\n`, stderr: '', exitCode: 0 }; },
      async commitExists() { return true; },
    } as unknown as GitService;
    const engine = new RollbackEngine(
      db, projects, new DefaultDenyAuthorizer(), deployments, git,
      {} as RestrictedCommandRunner, tasks, {} as HealthCheckService, {} as ServiceController, {} as DatabaseAdapterFactory,
    );
    const principal = { id: 'operator', kind: 'local' as const, projectScopes: ['project-a'], permissions: ['rollback:run'] as const };
    const plan = await engine.plan(task.taskId, 'project-a', principal);
    assert.equal(plan.status, 'BLOCKED');
    assert.equal(plan.codeAction, 'manual');
    assert.match(JSON.stringify(plan.evidence), /No explicit rollback command/);
    assert.equal(tasks.get(task.taskId)?.status, 'WAITING_FOR_USER');
  } finally { db.close(); }
});

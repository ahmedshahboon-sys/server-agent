import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { TaskEngine } from '../../src/tasks/task-engine.js';
import { RecoveryEngine } from '../../src/recovery/recovery-engine.js';
import type { DeploymentEngine } from '../../src/deployment/deployment-engine.js';
import type { RecoveryEvidenceCollector } from '../../src/recovery/evidence.js';
import { AttemptLimitError } from '../../src/core/errors.js';
import { projectFixture } from '../helpers.js';

test('recovery attempt limit stops automatic recovery and moves task to WAITING_FOR_USER', async () => {
  const db = new SqliteDatabase(':memory:');
  try {
    const projects = new ProjectRegistry(db);
    projects.create(projectFixture({
      permissions: ['project:read', 'recovery:read', 'recovery:run'],
      health: { type: 'none' },
      database: { adapter: 'none', defaultAccess: 'read' },
      deployment: { strategy: 'none', requireClean: true, validationRequired: false, restartService: false, healthRequired: false },
      environmentRefs: [],
    }));
    const tasks = new TaskEngine(db);
    const task = tasks.create('project-a', 'Interrupted task');
    const now = new Date().toISOString();
    const insert = db.raw.prepare('INSERT INTO recovery_runs(recovery_id,task_id,project_id,deployment_id,attempt,status,reason,evidence_json,decision_json,started_at,finished_at,error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    for (let attempt = 1; attempt <= 3; attempt += 1) insert.run(`recovery-${attempt}`, task.taskId, 'project-a', null, attempt, 'MANUAL_REQUIRED', 'test', '{}', null, now, now, null);
    const engine = new RecoveryEngine(db, projects, new DefaultDenyAuthorizer(), tasks, {} as DeploymentEngine, {} as RecoveryEvidenceCollector, 3);
    const principal = { id: 'operator', kind: 'local' as const, projectScopes: ['project-a'], permissions: ['recovery:run'] as const };
    await assert.rejects(engine.assess(task.taskId, 'project-a', principal), AttemptLimitError);
    assert.equal(tasks.get(task.taskId)?.status, 'WAITING_FOR_USER');
  } finally { db.close(); }
});

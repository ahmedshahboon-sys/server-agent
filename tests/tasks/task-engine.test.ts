import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TaskEngine } from '../../src/tasks/task-engine.js';
import { projectFixture } from '../helpers.js';

test('tasks persist checkpoints and resume state', () => {
  const db=new SqliteDatabase(':memory:'); const registry=new ProjectRegistry(db); registry.create(projectFixture()); const engine=new TaskEngine(db);
  try {
    const task=engine.create('project-a','Fix messaging',['analyze','test']);
    assert.equal(task.status,'PENDING');
    engine.resume(task.taskId);
    const checkpointed=engine.checkpoint(task.taskId,{currentStep:'test',completedSteps:['analyze'],remainingSteps:['test'],metadata:{token:'abc12345'}});
    assert.equal(checkpointed.currentStep,'test');
    assert.deepEqual(checkpointed.completedSteps,['analyze']);
    engine.recordFileModified(task.taskId,'src/a.ts');
    engine.recordCommand(task.taskId,{ command:'npm test', token:'never-store-me' });
    engine.recordTestResult(task.taskId,'unit',{ passed:true });
    const activity=engine.get(task.taskId);
    assert.deepEqual(activity?.filesModified,['src/a.ts']);
    assert.deepEqual(activity?.testsRun,['unit']);
    assert.equal(JSON.stringify(activity?.commandsExecuted).includes('never-store-me'),false);
    engine.pause(task.taskId); assert.equal(engine.resume(task.taskId).status,'RUNNING');
  } finally { db.close(); }
});

test('interrupted task states become RECOVERY_REQUIRED after restart reconciliation', () => {
  const db=new SqliteDatabase(':memory:'); const registry=new ProjectRegistry(db); registry.create(projectFixture()); const engine=new TaskEngine(db);
  try { const task=engine.create('project-a','Crash test'); engine.resume(task.taskId); assert.equal(engine.markInterruptedForRecovery(),1); assert.equal(engine.get(task.taskId)?.status,'RECOVERY_REQUIRED'); assert.equal(engine.resume(task.taskId).recoveryAttempts,1); }
  finally { db.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { RestrictedCommandRunner } from '../../src/commands/command-runner.js';
import { LocalValidationPipeline } from '../../src/validation/local-ci.js';
import { TaskEngine } from '../../src/tasks/task-engine.js';
import { AttemptLimitError } from '../../src/core/errors.js';
import { projectFixture, tempDir } from '../helpers.js';

const principal={id:'tester',kind:'local' as const,projectScopes:['project-a'],permissions:['commands:run'] as const};

test('local validation stops at first failing step and enforces attempt limit', async()=>{
  const temp=await tempDir('server-agent-ci-');const db=new SqliteDatabase(':memory:');const registry=new ProjectRegistry(db);
  registry.create(projectFixture({root:temp.path,permissions:['commands:run'],commands:{allowed:{lint:['node','-e','process.exit(0)'],testx:['node','-e','console.error("bad");process.exit(2)'],never:['node','-e','process.exit(0)']},validation:['lint','testx','never']}}));
  const task=new TaskEngine(db).create('project-a','Validation');const runner=new RestrictedCommandRunner(registry,new DefaultDenyAuthorizer(),{timeoutMs:1000,maxOutputBytes:1024});const pipeline=new LocalValidationPipeline(db,registry,runner,2);
  try{const first=await pipeline.run(task.taskId,'project-a',principal);assert.equal(first.passed,false);assert.deepEqual(first.steps.map(s=>s.name),['lint','testx']);await pipeline.run(task.taskId,'project-a',principal);await assert.rejects(pipeline.run(task.taskId,'project-a',principal),AttemptLimitError);}
  finally{db.close();await temp.cleanup();}
});

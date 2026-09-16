import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { GitService } from '../../src/git/git-service.js';
import { projectFixture, tempDir } from '../helpers.js';

const principal={id:'tester',kind:'local' as const,projectScopes:['project-a'],permissions:['git:read','git:write'] as const};

test('git service exposes fixed safe status/diff/log/branch/commit operations',async()=>{
  const temp=await tempDir('server-agent-git-');execFileSync('git',['init','-b','main'],{cwd:temp.path});execFileSync('git',['config','user.email','test@example.test'],{cwd:temp.path});execFileSync('git',['config','user.name','Test'],{cwd:temp.path});await fs.writeFile(path.join(temp.path,'a.txt'),'one');execFileSync('git',['add','a.txt'],{cwd:temp.path});execFileSync('git',['commit','-m','init'],{cwd:temp.path});await fs.writeFile(path.join(temp.path,'a.txt'),'two');
  const db=new SqliteDatabase(':memory:');const registry=new ProjectRegistry(db);registry.create(projectFixture({root:temp.path,permissions:['git:read','git:write']}));const git=new GitService(registry,new DefaultDenyAuthorizer(),{timeoutMs:2000,maxOutputBytes:4096});
  try{assert.match((await git.status('project-a',principal)).stdout,/a\.txt/);assert.match((await git.diff('project-a',principal)).stdout,/two/);assert.equal((await git.branch('project-a',principal)).stdout.trim(),'main');execFileSync('git',['add','a.txt'],{cwd:temp.path});assert.equal((await git.commit('project-a',principal,'safe commit')).exitCode,0);assert.match((await git.log('project-a',principal,2)).stdout,/safe commit/);}
  finally{db.close();await temp.cleanup();}
});

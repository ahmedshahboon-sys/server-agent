import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { GitService } from '../../src/git/git-service.js';
import { ValidationError } from '../../src/core/errors.js';
import { projectFixture, tempDir } from '../helpers.js';

const principal={id:'tester',kind:'local' as const,projectScopes:['project-a'],permissions:['git:read','git:write'] as const};

test('git service commits only explicit paths and excludes unrelated staged changes',async()=>{
  const temp=await tempDir('server-agent-git-');
  execFileSync('git',['init','-b','main'],{cwd:temp.path});
  execFileSync('git',['config','user.email','test@example.test'],{cwd:temp.path});
  execFileSync('git',['config','user.name','Test'],{cwd:temp.path});
  await fs.writeFile(path.join(temp.path,'a.txt'),'one');
  await fs.writeFile(path.join(temp.path,'b.txt'),'one');
  execFileSync('git',['add','a.txt','b.txt'],{cwd:temp.path});
  execFileSync('git',['commit','-m','init'],{cwd:temp.path});
  await fs.writeFile(path.join(temp.path,'a.txt'),'two');
  await fs.writeFile(path.join(temp.path,'b.txt'),'two');
  execFileSync('git',['add','b.txt'],{cwd:temp.path});

  const db=new SqliteDatabase(':memory:');const registry=new ProjectRegistry(db);registry.create(projectFixture({root:temp.path,permissions:['git:read','git:write']}));const git=new GitService(registry,new DefaultDenyAuthorizer(),{timeoutMs:2000,maxOutputBytes:4096});
  try{
    assert.match((await git.status('project-a',principal)).stdout,/a\.txt/);
    assert.match((await git.diff('project-a',principal)).stdout,/two/);
    assert.equal((await git.branch('project-a',principal)).stdout.trim(),'main');
    await assert.rejects(git.commit('project-a',principal,'no implicit staged commit',[]),ValidationError);
    assert.equal((await git.commit('project-a',principal,'safe commit',['a.txt'])).exitCode,0);
    const committed=execFileSync('git',['show','--pretty=','--name-only','HEAD'],{cwd:temp.path,encoding:'utf8'});
    assert.match(committed,/a\.txt/);
    assert.doesNotMatch(committed,/b\.txt/);
    const status=execFileSync('git',['status','--short'],{cwd:temp.path,encoding:'utf8'});
    assert.match(status,/M\s+b\.txt/);
    assert.match((await git.log('project-a',principal,2)).stdout,/safe commit/);
  }
  finally{db.close();await temp.cleanup();}
});

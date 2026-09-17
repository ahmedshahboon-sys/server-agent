import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { ProjectFileService } from '../../src/files/file-service.js';
import { AuthorizationError, ConflictError, SensitiveFileError } from '../../src/core/errors.js';
import { projectFixture, tempDir } from '../helpers.js';

const rw = { id:'tester', kind:'local' as const, projectScopes:['project-a'], permissions:['files:read','files:write'] as const };

test('file tools use atomic writes and SHA-256 guarded edits', async () => {
  const temp=await tempDir('server-agent-files-'); const db=new SqliteDatabase(':memory:'); const registry=new ProjectRegistry(db);
  registry.create(projectFixture({root:temp.path,permissions:['files:read','files:write']})); const service=new ProjectFileService(registry,new DefaultDenyAuthorizer(),{maxFileBytes:4096});
  try {
    await service.writeFile('project-a',rw,'src/a.txt','alpha\nbeta\n');
    const snapshot=await service.readFileSnapshot('project-a',rw,'src/a.txt');
    assert.equal(snapshot.content,'alpha\nbeta\n');
    assert.match(snapshot.sha256,/^[a-f0-9]{64}$/);
    await service.editFile('project-a',rw,'src/a.txt','beta','gamma',snapshot.sha256);
    assert.equal((await service.searchFiles('project-a',rw,'gamma')).length,1);
    assert.equal((await service.listFiles('project-a',rw,'src'))[0]?.path,'src/a.txt');
    const stale=await service.readFileSnapshot('project-a',rw,'src/a.txt');
    await service.writeFile('project-a',rw,'src/a.txt','changed elsewhere\n');
    await assert.rejects(service.editFile('project-a',rw,'src/a.txt','changed','edited',stale.sha256),ConflictError);
    const entries=await fs.readdir(path.join(temp.path,'src'));
    assert.equal(entries.some((entry)=>entry.includes('.server-agent-')&&entry.endsWith('.tmp')),false);
    await service.deleteFile('project-a',rw,'src/a.txt');
    await assert.rejects(service.readFile('project-a',rw,'../outside.txt'));
  } finally { db.close(); await temp.cleanup(); }
});

test('file tools enforce project authorization and expanded sensitive-file policy', async () => {
  const temp=await tempDir('server-agent-files-'); const db=new SqliteDatabase(':memory:'); const registry=new ProjectRegistry(db);
  await fs.writeFile(path.join(temp.path,'.env'),'fixture');
  await fs.writeFile(path.join(temp.path,'.npmrc'),'fixture');
  await fs.mkdir(path.join(temp.path,'.kube'));
  await fs.writeFile(path.join(temp.path,'.kube','config'),'fixture');
  registry.create(projectFixture({root:temp.path,permissions:['files:read','files:write']})); const service=new ProjectFileService(registry,new DefaultDenyAuthorizer(),{maxFileBytes:4096});
  try {
    await assert.rejects(service.readFile('project-a',rw,'.env'),SensitiveFileError);
    await assert.rejects(service.readFile('project-a',rw,'.npmrc'),SensitiveFileError);
    await assert.rejects(service.readFile('project-a',rw,'.kube/config'),SensitiveFileError);
    const other={...rw,projectScopes:['project-b']}; await assert.rejects(service.readFile('project-a',other,'x.txt'),AuthorizationError);
  } finally { db.close(); await temp.cleanup(); }
});

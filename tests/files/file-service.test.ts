import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { ProjectFileService } from '../../src/files/file-service.js';
import { AuthorizationError, SensitiveFileError } from '../../src/core/errors.js';
import { projectFixture, tempDir } from '../helpers.js';

const rw = { id:'tester', kind:'local' as const, projectScopes:['project-a'], permissions:['files:read','files:write'] as const };

test('file tools stay inside project and support read/write/edit/search/delete', async () => {
  const temp=await tempDir('server-agent-files-'); const db=new SqliteDatabase(':memory:'); const registry=new ProjectRegistry(db);
  registry.create(projectFixture({root:temp.path,permissions:['files:read','files:write']})); const service=new ProjectFileService(registry,new DefaultDenyAuthorizer(),{maxFileBytes:4096});
  try {
    await service.writeFile('project-a',rw,'src/a.txt','alpha\nbeta\n');
    assert.equal(await service.readFile('project-a',rw,'src/a.txt'),'alpha\nbeta\n');
    await service.editFile('project-a',rw,'src/a.txt','beta','gamma');
    assert.equal((await service.searchFiles('project-a',rw,'gamma')).length,1);
    assert.equal((await service.listFiles('project-a',rw,'src'))[0]?.path,'src/a.txt');
    await service.deleteFile('project-a',rw,'src/a.txt');
    await assert.rejects(service.readFile('project-a',rw,'../outside.txt'));
  } finally { db.close(); await temp.cleanup(); }
});

test('file tools enforce project authorization and sensitive-file policy', async () => {
  const temp=await tempDir('server-agent-files-'); const db=new SqliteDatabase(':memory:'); const registry=new ProjectRegistry(db);
  await fs.writeFile(path.join(temp.path,'.env'),'TOKEN=secret'); registry.create(projectFixture({root:temp.path,permissions:['files:read','files:write']})); const service=new ProjectFileService(registry,new DefaultDenyAuthorizer(),{maxFileBytes:4096});
  try {
    await assert.rejects(service.readFile('project-a',rw,'.env'),SensitiveFileError);
    const other={...rw,projectScopes:['project-b']}; await assert.rejects(service.readFile('project-a',other,'x.txt'),AuthorizationError);
  } finally { db.close(); await temp.cleanup(); }
});

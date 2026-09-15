import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectPathSandbox } from '../../src/security/sandbox.js';
import { SandboxViolationError, SensitiveFileError } from '../../src/core/errors.js';
import { tempDir } from '../helpers.js';

async function rejectsWith(promise: Promise<unknown>, type: new (...args: never[]) => Error): Promise<void> {
  await assert.rejects(promise, type);
}

describe('ProjectPathSandbox', () => {
  it('allows normal paths inside the project root', async () => {
    const root = await tempDir();
    try {
      await mkdir(path.join(root.path, 'src'));
      await writeFile(path.join(root.path, 'src', 'index.ts'), 'ok');
      const sandbox = await ProjectPathSandbox.create(root.path);
      assert.equal(await sandbox.resolveForRead('src/index.ts'), path.join(root.path, 'src', 'index.ts'));
      assert.equal(await sandbox.resolveForWrite('src/new.ts'), path.join(root.path, 'src', 'new.ts'));
    } finally { await root.cleanup(); }
  });

  for (const attack of ['../../etc/passwd', '../outside', 'src/../../../root/.ssh/id_rsa', '..\\..\\etc\\passwd']) {
    it(`blocks traversal path ${attack}`, async () => {
      const root = await tempDir();
      try {
        const sandbox = await ProjectPathSandbox.create(root.path);
        await rejectsWith(sandbox.resolveForRead(attack), SandboxViolationError);
        await rejectsWith(sandbox.resolveForWrite(attack), SandboxViolationError);
      } finally { await root.cleanup(); }
    });
  }

  for (const attack of ['/etc/passwd', '/root', '/root/.ssh']) {
    it(`blocks absolute path ${attack}`, async () => {
      const root = await tempDir();
      try {
        const sandbox = await ProjectPathSandbox.create(root.path);
        await rejectsWith(sandbox.resolveForRead(attack), SandboxViolationError);
      } finally { await root.cleanup(); }
    });
  }

  for (const attack of ['%2e%2e/etc/passwd', '..%2f..%2fetc%2fpasswd', '%2E%2E%5Croot', '%252e%252e%252fetc%252fpasswd', 'safe%00name']) {
    it(`blocks encoded traversal ${attack}`, async () => {
      const root = await tempDir();
      try {
        const sandbox = await ProjectPathSandbox.create(root.path);
        await rejectsWith(sandbox.resolveForWrite(attack), SandboxViolationError);
      } finally { await root.cleanup(); }
    });
  }

  it('blocks symlink escape for reads and writes', async () => {
    const root = await tempDir('agent-root-');
    const outside = await tempDir('agent-outside-');
    try {
      await writeFile(path.join(outside.path, 'outside.txt'), 'outside');
      await symlink(outside.path, path.join(root.path, 'escape'));
      const sandbox = await ProjectPathSandbox.create(root.path);
      await rejectsWith(sandbox.resolveForRead('escape/outside.txt'), SandboxViolationError);
      await rejectsWith(sandbox.resolveForWrite('escape/new.txt'), SandboxViolationError);
    } finally {
      await root.cleanup();
      await outside.cleanup();
    }
  });

  it('blocks a symlink file whose target is outside the project', async () => {
    const root = await tempDir('agent-root-');
    const outside = await tempDir('agent-outside-');
    try {
      const outsideFile = path.join(outside.path, 'outside.txt');
      await writeFile(outsideFile, 'outside');
      await symlink(outsideFile, path.join(root.path, 'link.txt'));
      const sandbox = await ProjectPathSandbox.create(root.path);
      await rejectsWith(sandbox.resolveForRead('link.txt'), SandboxViolationError);
      await rejectsWith(sandbox.resolveForWrite('link.txt'), SandboxViolationError);
    } finally {
      await root.cleanup();
      await outside.cleanup();
    }
  });

  for (const filename of ['.env', '.env.production', 'server.pem', 'private.key', 'id_rsa', 'credentials.json', 'secrets.yml', 'access-token.txt']) {
    it(`blocks sensitive file ${filename}`, async () => {
      const root = await tempDir();
      try {
        await writeFile(path.join(root.path, filename), 'not-a-real-secret');
        const sandbox = await ProjectPathSandbox.create(root.path);
        await rejectsWith(sandbox.resolveForRead(filename), SensitiveFileError);
        await rejectsWith(sandbox.resolveForWrite(filename), SensitiveFileError);
      } finally { await root.cleanup(); }
    });
  }
});

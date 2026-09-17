import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Authorizer, ProjectStore } from '../core/interfaces.js';
import type { Principal } from '../core/types.js';
import { AuthorizationError, ConflictError, ValidationError } from '../core/errors.js';
import { ProjectPathSandbox } from '../security/sandbox.js';

export interface FileServiceOptions {
  readonly maxFileBytes: number;
  readonly maxSearchResults?: number;
  readonly maxSearchFiles?: number;
}

export interface FileEntry {
  readonly path: string;
  readonly type: 'file' | 'directory' | 'symlink';
  readonly size: number;
}

export interface FileSnapshot {
  readonly content: string;
  readonly sha256: string;
}

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

function digest(content: string): string { return createHash('sha256').update(content, 'utf8').digest('hex'); }

export class ProjectFileService {
  private readonly writeLocks = new Map<string, Promise<void>>();

  public constructor(
    private readonly projects: ProjectStore,
    private readonly authorizer: Authorizer,
    private readonly options: FileServiceOptions,
  ) {}

  public async listFiles(projectId: string, principal: Principal, relativePath = '.'): Promise<readonly FileEntry[]> {
    this.authorizer.assertAllowed(principal, 'files:read', projectId);
    const sandbox = await this.sandbox(projectId, 'files:read');
    const resolved = await sandbox.resolveForRead(relativePath);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new ValidationError('Requested path is not a directory');
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const output: FileEntry[] = [];
    for (const entry of entries) {
      const childRelative = path.posix.join(relativePath.replaceAll('\\', '/'), entry.name);
      const child = path.join(resolved, entry.name);
      const childStat = await fs.lstat(child);
      output.push({
        path: childRelative.replace(/^\.\//, ''),
        type: childStat.isSymbolicLink() ? 'symlink' : childStat.isDirectory() ? 'directory' : 'file',
        size: childStat.size,
      });
    }
    return output.sort((a, b) => a.path.localeCompare(b.path));
  }

  public async readFile(projectId: string, principal: Principal, relativePath: string): Promise<string> {
    this.authorizer.assertAllowed(principal, 'files:read', projectId);
    const sandbox = await this.sandbox(projectId, 'files:read');
    const resolved = await sandbox.resolveForRead(relativePath);
    return this.readResolved(resolved);
  }

  public async readFileSnapshot(projectId: string, principal: Principal, relativePath: string): Promise<FileSnapshot> {
    const content = await this.readFile(projectId, principal, relativePath);
    return { content, sha256: digest(content) };
  }

  public async writeFile(projectId: string, principal: Principal, relativePath: string, content: string): Promise<void> {
    this.authorizer.assertAllowed(principal, 'files:write', projectId);
    this.assertContentSize(content);
    const sandbox = await this.sandbox(projectId, 'files:write');
    const resolved = await sandbox.resolveForWrite(relativePath);
    await this.withWriteLock(resolved, () => this.atomicWrite(resolved, content));
  }

  public async editFile(
    projectId: string,
    principal: Principal,
    relativePath: string,
    expected: string,
    replacement: string,
    expectedSha256: string,
  ): Promise<void> {
    if (expected.length === 0) throw new ValidationError('Edit expected text must not be empty');
    if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new ValidationError('Edit expected_sha256 must be a SHA-256 hex digest');
    this.authorizer.assertAllowed(principal, 'files:read', projectId);
    this.authorizer.assertAllowed(principal, 'files:write', projectId);
    const sandbox = await this.sandbox(projectId, 'files:write');
    const resolved = await sandbox.resolveForRead(relativePath);
    await this.withWriteLock(resolved, async () => {
      const current = await this.readResolved(resolved);
      const currentHash = digest(current);
      if (currentHash !== expectedSha256.toLowerCase()) throw new ConflictError('File changed since it was read');
      const first = current.indexOf(expected);
      if (first < 0) throw new ValidationError('Expected text was not found');
      if (current.indexOf(expected, first + expected.length) >= 0) throw new ValidationError('Expected text is not unique');
      const next = `${current.slice(0, first)}${replacement}${current.slice(first + expected.length)}`;
      this.assertContentSize(next);
      await this.atomicWrite(resolved, next, currentHash);
    });
  }

  public async deleteFile(projectId: string, principal: Principal, relativePath: string): Promise<void> {
    this.authorizer.assertAllowed(principal, 'files:write', projectId);
    const sandbox = await this.sandbox(projectId, 'files:write');
    const resolved = await sandbox.resolveForRead(relativePath);
    await this.withWriteLock(resolved, async () => {
      const stat = await fs.lstat(resolved);
      if (!stat.isFile()) throw new ValidationError('Only regular files can be deleted');
      await fs.unlink(resolved);
      await this.syncDirectory(path.dirname(resolved));
    });
  }

  public async searchFiles(projectId: string, principal: Principal, query: string): Promise<readonly SearchMatch[]> {
    this.authorizer.assertAllowed(principal, 'files:read', projectId);
    if (query.length === 0) throw new ValidationError('Search query must not be empty');
    const sandbox = await this.sandbox(projectId, 'files:read');
    const maxResults = this.options.maxSearchResults ?? 100;
    const maxFiles = this.options.maxSearchFiles ?? 1000;
    const results: SearchMatch[] = [];
    const queue = ['.'];
    const visited = new Set<string>();
    let filesSeen = 0;

    while (queue.length > 0 && results.length < maxResults && filesSeen < maxFiles) {
      const relative = queue.shift();
      if (relative === undefined) break;
      let resolved: string;
      try { resolved = await sandbox.resolveForRead(relative); } catch { continue; }
      const real = await fs.realpath(resolved);
      if (visited.has(real)) continue;
      visited.add(real);
      const stat = await fs.stat(real);
      if (stat.isDirectory()) {
        const entries = await fs.readdir(real, { withFileTypes: true });
        for (const entry of entries) queue.push(path.posix.join(relative.replaceAll('\\', '/'), entry.name));
        continue;
      }
      if (!stat.isFile() || stat.size > this.options.maxFileBytes) continue;
      filesSeen += 1;
      let text: string;
      try { text = await this.readFile(projectId, principal, relative); } catch { continue; }
      const lines = text.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (results.length < maxResults && line.includes(query)) results.push({ path: relative.replace(/^\.\//, ''), line: index + 1, text: line });
      });
    }
    return results;
  }

  private async readResolved(resolved: string): Promise<string> {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new ValidationError('Requested path is not a file');
    if (stat.size > this.options.maxFileBytes) throw new ValidationError('File exceeds configured read limit');
    return fs.readFile(resolved, 'utf8');
  }

  private assertContentSize(content: string): void {
    if (Buffer.byteLength(content) > this.options.maxFileBytes) throw new ValidationError('File exceeds configured write limit');
  }

  private async atomicWrite(resolved: string, content: string, expectedCurrentHash?: string): Promise<void> {
    const directory = path.dirname(resolved);
    await fs.mkdir(directory, { recursive: true, mode: 0o750 });
    const tempPath = path.join(directory, `.${path.basename(resolved)}.server-agent-${randomUUID()}.tmp`);
    let tempExists = false;
    try {
      const handle = await fs.open(tempPath, 'wx', 0o640);
      tempExists = true;
      try {
        await handle.writeFile(content, { encoding: 'utf8' });
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (expectedCurrentHash !== undefined) {
        const latest = await this.readResolved(resolved);
        if (digest(latest) !== expectedCurrentHash) throw new ConflictError('File changed during edit');
      }
      await fs.rename(tempPath, resolved);
      tempExists = false;
      await this.syncDirectory(directory);
    } finally {
      if (tempExists) await fs.unlink(tempPath).catch(() => undefined);
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(directory, 'r');
      await handle.sync();
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(code)) throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async withWriteLock<T>(resolved: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeLocks.get(resolved) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.then(() => gate);
    this.writeLocks.set(resolved, current);
    await previous;
    try { return await operation(); }
    finally {
      release?.();
      if (this.writeLocks.get(resolved) === current) this.writeLocks.delete(resolved);
    }
  }

  private async sandbox(projectId: string, permission: 'files:read' | 'files:write'): Promise<ProjectPathSandbox> {
    const project = this.projects.get(projectId);
    if (project === null || !project.enabled) throw new ValidationError('Project is not available');
    if (!project.permissions.includes(permission)) throw new AuthorizationError(`Project does not permit ${permission}`);
    return ProjectPathSandbox.create(project.root);
  }
}

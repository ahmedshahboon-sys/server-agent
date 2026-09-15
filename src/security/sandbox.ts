import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SandboxViolationError } from '../core/errors.js';
import { SensitiveFilePolicy } from './sensitive-files.js';

const ENCODED_DANGEROUS = /%(?:2e|2f|5c|00|25)/i;

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function decodedVariants(value: string): readonly string[] {
  const variants = [value];
  let current = value;
  for (let i = 0; i < 3; i += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      variants.push(decoded);
      current = decoded;
    } catch {
      throw new SandboxViolationError('Malformed path encoding is not allowed');
    }
  }
  return variants;
}

function validateUserPath(userPath: string): void {
  if (userPath.includes('\0')) throw new SandboxViolationError('Null bytes are not allowed');
  if (path.isAbsolute(userPath)) throw new SandboxViolationError('Absolute paths are not allowed');
  if (ENCODED_DANGEROUS.test(userPath)) throw new SandboxViolationError('Encoded traversal sequences are not allowed');

  for (const variant of decodedVariants(userPath)) {
    if (variant.includes('\0')) throw new SandboxViolationError('Null bytes are not allowed');
    if (path.isAbsolute(variant)) throw new SandboxViolationError('Absolute paths are not allowed');
    const normalizedSegments = variant.replaceAll('\\', '/').split('/');
    if (normalizedSegments.some((segment) => segment === '..')) {
      throw new SandboxViolationError('Path traversal is not allowed');
    }
  }
}

async function nearestExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export class ProjectPathSandbox {
  private constructor(
    private readonly realRoot: string,
    private readonly sensitiveFiles: SensitiveFilePolicy,
  ) {}

  public static async create(projectRoot: string, sensitiveFiles = new SensitiveFilePolicy()): Promise<ProjectPathSandbox> {
    const realRoot = await fs.realpath(projectRoot);
    return new ProjectPathSandbox(realRoot, sensitiveFiles);
  }

  public get root(): string { return this.realRoot; }

  public async resolveForRead(userPath: string, options: { allowSensitive?: boolean } = {}): Promise<string> {
    validateUserPath(userPath);
    if (!options.allowSensitive) this.sensitiveFiles.assertReadable(userPath);

    const candidate = path.resolve(this.realRoot, userPath);
    let realCandidate: string;
    try {
      realCandidate = await fs.realpath(candidate);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new SandboxViolationError('Requested path does not exist');
      }
      throw error;
    }
    if (!isInside(this.realRoot, realCandidate)) throw new SandboxViolationError('Resolved path escapes project sandbox');
    return realCandidate;
  }

  public async resolveForWrite(userPath: string, options: { allowSensitive?: boolean } = {}): Promise<string> {
    validateUserPath(userPath);
    if (!options.allowSensitive) this.sensitiveFiles.assertWritable(userPath);

    const candidate = path.resolve(this.realRoot, userPath);
    const existingAncestor = await nearestExistingAncestor(candidate);
    const realAncestor = await fs.realpath(existingAncestor);
    if (!isInside(this.realRoot, realAncestor)) throw new SandboxViolationError('Write path escapes project sandbox');

    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) {
        const target = await fs.realpath(candidate);
        if (!isInside(this.realRoot, target)) throw new SandboxViolationError('Symlink target escapes project sandbox');
      } else {
        const realCandidate = await fs.realpath(candidate);
        if (!isInside(this.realRoot, realCandidate)) throw new SandboxViolationError('Write path escapes project sandbox');
      }
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }

    return candidate;
  }
}

import type { Authorizer, ProjectStore } from '../core/interfaces.js';
import type { Principal } from '../core/types.js';
import { AuthorizationError, ValidationError } from '../core/errors.js';
import { ProjectPathSandbox } from '../security/sandbox.js';
import { executeArgv, type ProcessExecutionResult } from '../commands/process-executor.js';

export interface GitServiceOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly environment?: NodeJS.ProcessEnv;
}

export class GitService {
  public constructor(
    private readonly projects: ProjectStore,
    private readonly authorizer: Authorizer,
    private readonly options: GitServiceOptions,
  ) {}

  public status(projectId: string, principal: Principal): Promise<ProcessExecutionResult> {
    return this.read(projectId, principal, ['git', 'status', '--short', '--branch']);
  }

  public diff(projectId: string, principal: Principal, staged = false): Promise<ProcessExecutionResult> {
    return this.read(projectId, principal, ['git', 'diff', ...(staged ? ['--cached'] : []), '--']);
  }

  public log(projectId: string, principal: Principal, limit = 20): Promise<ProcessExecutionResult> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    return this.read(projectId, principal, ['git', 'log', `-${safeLimit}`, '--oneline', '--decorate', '--no-color']);
  }

  public branch(projectId: string, principal: Principal): Promise<ProcessExecutionResult> {
    return this.read(projectId, principal, ['git', 'branch', '--show-current']);
  }

  public headCommit(projectId: string, principal: Principal): Promise<ProcessExecutionResult> {
    return this.read(projectId, principal, ['git', 'rev-parse', 'HEAD']);
  }

  public changedFiles(projectId: string, principal: Principal): Promise<ProcessExecutionResult> {
    return this.read(projectId, principal, ['git', 'diff', '--name-only', '--']);
  }

  public diffStat(projectId: string, principal: Principal): Promise<ProcessExecutionResult> {
    return this.read(projectId, principal, ['git', 'diff', '--stat', '--']);
  }

  public async commitExists(projectId: string, principal: Principal, commit: string): Promise<boolean> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) throw new ValidationError('Git commit reference must be a full SHA');
    const result = await this.read(projectId, principal, ['git', 'cat-file', '-e', `${commit}^{commit}`]);
    return result.exitCode === 0;
  }

  public diffBetween(projectId: string, principal: Principal, baseCommit: string, headCommit: string): Promise<ProcessExecutionResult> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseCommit) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(headCommit)) throw new ValidationError('Git commit references must be full SHAs');
    return this.read(projectId, principal, ['git', 'diff', '--name-only', `${baseCommit}..${headCommit}`, '--']);
  }

  public async commit(projectId: string, principal: Principal, message: string, paths: readonly string[]): Promise<ProcessExecutionResult> {
    this.authorizer.assertAllowed(principal, 'git:write', projectId);
    if (message.trim().length < 3 || message.length > 200) throw new ValidationError('Commit message must be 3-200 characters');
    if (paths.length === 0 || paths.length > 256) throw new ValidationError('Git commit requires 1-256 explicit project paths');
    const project = this.projects.get(projectId);
    if (project === null || !project.enabled) throw new ValidationError('Project is not available');
    const sandbox = await ProjectPathSandbox.create(project.root);
    for (const candidate of paths) await sandbox.resolveForRead(candidate);
    await this.exec(projectId, ['git', 'add', '--', ...paths]);
    return this.exec(projectId, ['git', '-c', 'core.hooksPath=/dev/null', 'commit', '--only', '-m', message, '--', ...paths]);
  }

  private async read(projectId: string, principal: Principal, argv: readonly string[]): Promise<ProcessExecutionResult> {
    this.authorizer.assertAllowed(principal, 'git:read', projectId);
    return this.exec(projectId, argv);
  }

  private async exec(projectId: string, argv: readonly string[]): Promise<ProcessExecutionResult> {
    const project = this.projects.get(projectId);
    if (project === null || !project.enabled) throw new ValidationError('Project is not available');
    const required = argv.includes('commit') || argv.includes('add') ? 'git:write' : 'git:read';
    if (!project.permissions.includes(required)) throw new AuthorizationError(`Project does not permit ${required}`);
    const sandbox = await ProjectPathSandbox.create(project.root);
    const source = this.options.environment ?? process.env;
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']) {
      if (source[key] !== undefined) env[key] = source[key];
    }
    return executeArgv(argv, {
      cwd: sandbox.root,
      env,
      timeoutMs: this.options.timeoutMs,
      maxOutputBytes: this.options.maxOutputBytes,
    });
  }
}

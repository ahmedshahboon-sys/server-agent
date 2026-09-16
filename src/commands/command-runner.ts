import path from 'node:path';
import type { Authorizer, ProjectStore } from '../core/interfaces.js';
import type { Principal, ProjectRecord } from '../core/types.js';
import { AuthorizationError, CommandDeniedError, ValidationError } from '../core/errors.js';
import { ProjectPathSandbox } from '../security/sandbox.js';
import { executeArgv, type ProcessExecutionResult } from './process-executor.js';

const DENIED_EXECUTABLES = new Set([
  'sudo', 'su', 'bash', 'sh', 'zsh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'pwsh',
  'rm', 'mkfs', 'shutdown', 'reboot', 'halt', 'poweroff', 'iptables', 'nft', 'mount', 'umount', 'dd',
]);

export interface RestrictedCommandOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface CommandRunHooks {
  readonly signal?: AbortSignal;
  readonly onSpawn?: (pid: number | undefined) => void;
}

function configuredArgv(project: ProjectRecord, commandId: string): readonly string[] | undefined {
  if (commandId === 'build') return project.commands.build;
  if (commandId === 'test') return project.commands.test;
  if (commandId === 'deploy') return project.commands.deploy;
  return project.commands.allowed?.[commandId];
}

function baseEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'NODE_ENV', 'LANG', 'LC_ALL']) {
    const value = source[key];
    if (value !== undefined) output[key] = value;
  }
  return output;
}

export class RestrictedCommandRunner {
  public constructor(
    private readonly projects: ProjectStore,
    private readonly authorizer: Authorizer,
    private readonly options: RestrictedCommandOptions,
  ) {}


  public async runRollback(projectId: string, principal: Principal, targetCommit: string): Promise<ProcessExecutionResult> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(targetCommit)) throw new ValidationError('Rollback target must be a full Git commit SHA');
    this.authorizer.assertAllowed(principal, 'commands:run', projectId);
    const project = this.projects.get(projectId);
    if (project === null || !project.enabled) throw new ValidationError('Project is not available');
    if (!project.permissions.includes('commands:run')) throw new AuthorizationError('Project does not permit command execution');
    const configured = project.commands.rollback;
    if (configured === undefined || configured.length === 0) throw new CommandDeniedError('Rollback command is not configured');
    if (!configured.some((argument) => argument.includes('{target_commit}'))) throw new CommandDeniedError('Rollback command must explicitly reference {target_commit}');
    const argv = configured.map((argument) => argument.replaceAll('{target_commit}', targetCommit));
    return this.executeConfigured(project, argv);
  }

  public async run(projectId: string, principal: Principal, commandId: string, hooks: CommandRunHooks = {}): Promise<ProcessExecutionResult> {
    this.authorizer.assertAllowed(principal, 'commands:run', projectId);
    const project = this.projects.get(projectId);
    if (project === null || !project.enabled) throw new ValidationError('Project is not available');
    if (!project.permissions.includes('commands:run')) throw new AuthorizationError('Project does not permit command execution');
    const argv = configuredArgv(project, commandId);
    if (argv === undefined || argv.length === 0) throw new CommandDeniedError(`Command ${commandId} is not configured`);

    return this.executeConfigured(project, argv, hooks);
  }

  private async executeConfigured(project: ProjectRecord, argv: readonly string[], hooks: CommandRunHooks = {}): Promise<ProcessExecutionResult> {
    const executable = path.basename(argv[0] ?? '').toLowerCase();
    if (DENIED_EXECUTABLES.has(executable)) throw new CommandDeniedError(`Executable ${executable} is blocked`);
    const sandbox = await ProjectPathSandbox.create(project.root);
    const sourceEnv = this.options.environment ?? process.env;
    const env = baseEnvironment(sourceEnv);
    const secretValues: string[] = [];
    for (const key of project.environmentRefs) {
      const value = sourceEnv[key];
      if (value !== undefined) {
        env[key] = value;
        secretValues.push(value);
      }
    }
    return executeArgv(argv, {
      cwd: sandbox.root,
      env,
      timeoutMs: this.options.timeoutMs,
      maxOutputBytes: this.options.maxOutputBytes,
      secretValues,
      ...(hooks.signal === undefined ? {} : { signal: hooks.signal }),
      ...(hooks.onSpawn === undefined ? {} : { onSpawn: hooks.onSpawn }),
    });
  }
}

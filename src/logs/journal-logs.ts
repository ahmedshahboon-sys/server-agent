import type { Authorizer, ProjectStore } from '../core/interfaces.js';
import type { Principal } from '../core/types.js';
import { AuthorizationError, ValidationError } from '../core/errors.js';
import { executeArgv } from '../commands/process-executor.js';
import { assertServiceName } from '../services/service-controller.js';

export interface LogReadResult { readonly text: string; readonly truncated: boolean; readonly lineLimit: number; }

export class JournalLogReader {
  public constructor(
    private readonly projects: ProjectStore,
    private readonly authorizer: Authorizer,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly maxOutputBytes = 262_144,
  ) {}

  public async read(projectId: string, principal: Principal, lines = 200): Promise<LogReadResult> {
    this.authorizer.assertAllowed(principal, 'logs:read', projectId);
    const project = this.projects.get(projectId);
    if (project === null || !project.enabled) throw new ValidationError('Project is not available');
    if (!project.permissions.includes('logs:read')) throw new AuthorizationError('Project does not permit log access');
    if (project.serviceName === undefined) throw new ValidationError('Project has no service configured');
    assertServiceName(project.serviceName);
    const lineLimit = Math.max(1, Math.min(2_000, Math.trunc(lines)));
    const secrets = project.environmentRefs.map((key) => this.environment[key]).filter((value): value is string => value !== undefined);
    const result = await executeArgv(['journalctl', '--unit', project.serviceName, '--no-pager', '--output=short-iso', '--lines', String(lineLimit)], {
      cwd: '/', env: { PATH: this.environment.PATH ?? '/usr/bin:/bin', LANG: this.environment.LANG ?? 'C.UTF-8' }, timeoutMs: 10_000,
      maxOutputBytes: this.maxOutputBytes, secretValues: secrets,
    });
    if (result.exitCode !== 0) throw new ValidationError('Journal read failed', { exitCode: result.exitCode, stderr: result.stderr });
    return { text: result.stdout, truncated: result.stdoutTruncated, lineLimit };
  }
}

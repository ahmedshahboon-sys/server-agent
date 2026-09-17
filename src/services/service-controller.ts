import { randomUUID } from 'node:crypto';
import type { Authorizer, ProjectStore } from '../core/interfaces.js';
import type { Principal } from '../core/types.js';
import { AuthorizationError, ValidationError } from '../core/errors.js';
import { executeArgv } from '../commands/process-executor.js';
import { IdempotencyStore, idempotencyFingerprint } from '../idempotency/idempotency.js';
import { OperationLeaseStore } from '../operations/operation-lease.js';
import { redactError } from '../security/redaction.js';

export interface ServiceSnapshot {
  readonly active: boolean;
  readonly state: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface ServiceController {
  status(serviceName: string): Promise<ServiceSnapshot>;
  restart(serviceName: string): Promise<void>;
}

export function assertServiceName(serviceName: string): void {
  if (!/^[A-Za-z0-9@_.:-]{1,128}\.service$/.test(serviceName)) throw new ValidationError('Invalid systemd service name');
}

export class SystemdServiceController implements ServiceController {
  public constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  public async status(serviceName: string): Promise<ServiceSnapshot> {
    assertServiceName(serviceName);
    const result = await executeArgv(['systemctl', 'is-active', serviceName], { cwd: '/', env: this.baseEnv(), timeoutMs: 5_000, maxOutputBytes: 16_384 });
    const state = result.stdout.trim() || result.stderr.trim() || 'unknown';
    return { active: result.exitCode === 0 && state === 'active', state, details: { exitCode: result.exitCode } };
  }

  public async restart(serviceName: string): Promise<void> {
    assertServiceName(serviceName);
    const result = await executeArgv(['systemctl', 'restart', serviceName], { cwd: '/', env: this.baseEnv(), timeoutMs: 30_000, maxOutputBytes: 32_768 });
    if (result.exitCode !== 0) throw new ValidationError('Service restart failed', { serviceName, exitCode: result.exitCode, stderr: result.stderr });
  }

  private baseEnv(): NodeJS.ProcessEnv {
    return { PATH: this.environment.PATH ?? '/usr/sbin:/usr/bin:/sbin:/bin', LANG: this.environment.LANG ?? 'C.UTF-8' };
  }
}

export interface ServiceMutationSafety {
  readonly idempotency?: IdempotencyStore;
  readonly leases?: OperationLeaseStore;
  readonly ownerId?: string;
  readonly leaseTtlMs?: number;
}

export class ProjectServiceManager {
  private readonly mutationOwner:string;
  public constructor(private readonly projects: ProjectStore, private readonly authorizer: Authorizer, private readonly controller: ServiceController, private readonly mutationSafety:ServiceMutationSafety={}) { this.mutationOwner=mutationSafety.ownerId??randomUUID(); }

  public async status(projectId: string, principal: Principal): Promise<ServiceSnapshot> {
    this.authorizer.assertAllowed(principal, 'service:read', projectId);
    const project = this.projects.get(projectId);
    if (project === null || !project.enabled) throw new ValidationError('Project is not available');
    if (!project.permissions.includes('service:read')) throw new AuthorizationError('Project does not permit service status');
    if (project.serviceName === undefined) throw new ValidationError('Project has no service configured');
    return this.controller.status(project.serviceName);
  }

  public async restart(projectId: string, principal: Principal, idempotencyKey?:string): Promise<void> {
    this.authorizer.assertAllowed(principal, 'service:restart', projectId);
    const project = this.projects.get(projectId);
    if (project === null || !project.enabled) throw new ValidationError('Project is not available');
    if (!project.permissions.includes('service:restart')) throw new AuthorizationError('Project does not permit service restart');
    if (project.serviceName === undefined) throw new ValidationError('Project has no service configured');
    const store=this.mutationSafety.idempotency;
    if(store===undefined){await this.controller.restart(project.serviceName);return;}
    if(idempotencyKey===undefined||idempotencyKey.trim()==='')throw new ValidationError('idempotency_key is required for service restart');
    const scope=`service-restart:${projectId}`,fingerprint=idempotencyFingerprint({serviceName:project.serviceName});
    const replay=store.requireReplayable(scope,idempotencyKey,fingerprint);if(replay!==null)return;
    store.begin(scope,idempotencyKey,fingerprint);
    const owner=`${this.mutationOwner}:restart:${idempotencyKey}`;let lease=false;
    try{
      if(this.mutationSafety.leases!==undefined){this.mutationSafety.leases.acquire(projectId,'service-restart',owner,this.mutationSafety.leaseTtlMs??60_000);lease=true;}
      await this.controller.restart(project.serviceName);store.complete(scope,idempotencyKey,{ok:true,serviceName:project.serviceName});
    }catch(error){const current=store.get(scope,idempotencyKey);if(current?.status==='IN_PROGRESS')store.fail(scope,idempotencyKey,redactError(error));throw error;}
    finally{if(lease)this.mutationSafety.leases?.release(projectId,owner);}
  }
}

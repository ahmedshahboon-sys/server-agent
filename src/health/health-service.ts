import { randomUUID } from 'node:crypto';
import net from 'node:net';
import type { Authorizer, ProjectStore } from '../core/interfaces.js';
import type { HealthState, Principal, ProjectRecord } from '../core/types.js';
import { AuthorizationError, ValidationError } from '../core/errors.js';
import type { SqliteDatabase } from '../database/sqlite.js';
import type { DatabaseAdapterFactory } from '../database/database-service.js';
import type { ServiceController, ServiceSnapshot } from '../services/service-controller.js';
import { redactValue } from '../security/redaction.js';

export interface HttpProbeResult { readonly ok: boolean; readonly statusCode: number | null; readonly latencyMs: number; readonly error?: string; }
export interface HttpProbe { check(url: URL, timeoutMs: number, expectedStatus: readonly number[]): Promise<HttpProbeResult>; }

export class FetchHttpProbe implements HttpProbe {
  public async check(url: URL, timeoutMs: number, expectedStatus: readonly number[]): Promise<HttpProbeResult> {
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') throw new ValidationError('Unsafe health check URL');
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref();
    try {
      const response = await fetch(url, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { 'user-agent': 'server-agent-health/1' } });
      return { ok: expectedStatus.includes(response.status), statusCode: response.status, latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, statusCode: null, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
    } finally { clearTimeout(timer); }
  }
}

export interface HealthCheckResult {
  readonly state: HealthState;
  readonly checkedAt: string;
  readonly checks: readonly Readonly<Record<string, unknown>>[];
}

function combine(states: readonly HealthState[]): HealthState {
  if (states.length === 0 || states.every((state) => state === 'UNKNOWN')) return 'UNKNOWN';
  if (states.includes('UNHEALTHY')) return 'UNHEALTHY';
  if (states.every((state) => state === 'HEALTHY')) return 'HEALTHY';
  return 'DEGRADED';
}

function isPrivateLiteral(hostname: string): boolean {
  const kind = net.isIP(hostname);
  if (kind === 4) {
    const [a=0,b=0] = hostname.split('.').map(Number);
    return a===0||a===10||a===127||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168);
  }
  if (kind === 6) {
    const lower=hostname.toLowerCase();
    return lower==='::1'||lower==='::'||lower.startsWith('fc')||lower.startsWith('fd')||lower.startsWith('fe8')||lower.startsWith('fe9')||lower.startsWith('fea')||lower.startsWith('feb');
  }
  return false;
}

function buildHealthUrl(project: ProjectRecord): URL {
  if (project.domain === undefined || project.health.path === undefined) throw new ValidationError('HTTP health check requires project domain and health path');
  const hostname=project.domain.toLowerCase();
  if (hostname.includes('@') || hostname.includes('/') || hostname.includes(':')) throw new ValidationError('Project domain must be a hostname only');
  if (hostname==='localhost'||hostname.endsWith('.localhost')||hostname==='metadata.google.internal'||isPrivateLiteral(hostname)) throw new ValidationError('Private or local HTTP health targets are not allowed');
  const scheme = project.health.scheme ?? 'https';
  const port = project.health.port === undefined ? '' : `:${project.health.port}`;
  return new URL(`${scheme}://${hostname}${port}${project.health.path}`);
}

export class HealthCheckService {
  public constructor(
    private readonly db: SqliteDatabase,
    private readonly projects: ProjectStore,
    private readonly authorizer: Authorizer,
    private readonly services: ServiceController,
    private readonly http: HttpProbe,
    private readonly databases: DatabaseAdapterFactory,
  ) {}

  public async check(projectId: string, principal: Principal, context: { taskId?: string; deploymentId?: string } = {}): Promise<HealthCheckResult> {
    this.authorizer.assertAllowed(principal, 'health:read', projectId);
    const project = this.projects.get(projectId);
    if (project === null || !project.enabled) throw new ValidationError('Project is not available');
    if (!project.permissions.includes('health:read')) throw new AuthorizationError('Project does not permit health checks');

    const checks: Readonly<Record<string, unknown>>[] = [];
    const states: HealthState[] = [];
    const type = project.health.type;
    if (type === 'service' || type === 'composite') {
      if (project.serviceName === undefined) { states.push('UNKNOWN'); checks.push({ type: 'service', state: 'UNKNOWN', reason: 'service not configured' }); }
      else {
        try { const snapshot: ServiceSnapshot = await this.services.status(project.serviceName); const state: HealthState = snapshot.active ? 'HEALTHY' : 'UNHEALTHY'; states.push(state); checks.push({ type: 'service', state, service: project.serviceName, snapshot }); }
        catch (error) { states.push('UNKNOWN'); checks.push({ type: 'service', state: 'UNKNOWN', error: error instanceof Error ? error.message : String(error) }); }
      }
    }
    if (type === 'http' || type === 'composite') {
      try {
        const expected = project.health.expectedStatus ?? Array.from({ length: 200 }, (_, index) => 200 + index);
        const result = await this.http.check(buildHealthUrl(project), project.health.timeoutMs ?? 5_000, expected);
        const state: HealthState = result.ok ? 'HEALTHY' : 'UNHEALTHY'; states.push(state); checks.push({ type: 'http', state, statusCode: result.statusCode, latencyMs: result.latencyMs, ...(result.error === undefined ? {} : { error: result.error }) });
      } catch (error) { states.push('UNKNOWN'); checks.push({ type: 'http', state: 'UNKNOWN', error: error instanceof Error ? error.message : String(error) }); }
    }
    if (type === 'database' || type === 'composite') {
      if (project.database.adapter === 'none' || !project.permissions.includes('database:read')) { states.push('UNKNOWN'); checks.push({ type: 'database', state: 'UNKNOWN', reason: 'database health not permitted/configured' }); }
      else {
        try { const adapter = await this.databases.create(project); try { const status = await adapter.status(project.health.timeoutMs ?? 5_000); const state: HealthState = status.connected ? 'HEALTHY' : 'UNHEALTHY'; states.push(state); checks.push({ type: 'database', state, latencyMs: status.latencyMs }); } finally { await adapter.close(); } }
        catch (error) { states.push('UNHEALTHY'); checks.push({ type: 'database', state: 'UNHEALTHY', error: error instanceof Error ? error.message : String(error) }); }
      }
    }
    if (type === 'none') checks.push({ type: 'none', state: 'UNKNOWN' });

    const result: HealthCheckResult = { state: combine(states), checkedAt: new Date().toISOString(), checks: redactValue(checks) };
    this.db.raw.prepare('INSERT INTO health_checks(health_check_id,task_id,deployment_id,project_id,checked_at,state,result_json) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), context.taskId ?? null, context.deploymentId ?? null, projectId, result.checkedAt, result.state, JSON.stringify(result));
    return result;
  }
}

import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
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
export interface ResolvedAddress { readonly address: string; readonly family: number; }
export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

const BLOCKED_ADDRESSES = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],
  ['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],
  ['224.0.0.0',4],['240.0.0.0',4],
] as const) BLOCKED_ADDRESSES.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8],['2001:db8::',32],['::ffff:0:0',96],
] as const) BLOCKED_ADDRESSES.addSubnet(address, prefix, 'ipv6');

export function isPublicNetworkAddress(address: string, family?: number): boolean {
  const detected = family ?? net.isIP(address);
  if (detected !== 4 && detected !== 6) return false;
  return !BLOCKED_ADDRESSES.check(address, detected === 4 ? 'ipv4' : 'ipv6');
}

async function systemResolve(hostname: string): Promise<readonly ResolvedAddress[]> {
  const literal = net.isIP(hostname);
  if (literal === 4 || literal === 6) return [{ address: hostname, family: literal }];
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((item) => ({ address: item.address, family: item.family }));
}

function safeResolvedAddresses(addresses: readonly ResolvedAddress[]): readonly ResolvedAddress[] {
  if (addresses.length === 0) throw new ValidationError('Health target did not resolve to an address');
  if (addresses.some((item) => !isPublicNetworkAddress(item.address, item.family))) {
    throw new ValidationError('Health target resolves to a private or reserved network address');
  }
  return addresses;
}

export class FetchHttpProbe implements HttpProbe {
  public constructor(private readonly resolver: HostResolver = systemResolve) {}

  public async check(url: URL, timeoutMs: number, expectedStatus: readonly number[]): Promise<HttpProbeResult> {
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') throw new ValidationError('Unsafe health check URL');
    const started = Date.now();
    try {
      const addresses = safeResolvedAddresses(await this.resolver(url.hostname));
      const target = addresses[0];
      if (target === undefined) throw new ValidationError('Health target did not resolve to an address');
      const statusCode = await this.requestPinned(url, target, timeoutMs);
      return { ok: expectedStatus.includes(statusCode), statusCode, latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, statusCode: null, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private requestPinned(url: URL, target: ResolvedAddress, timeoutMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const base = {
        hostname: target.address,
        family: target.family,
        port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { host: url.host, 'user-agent': 'server-agent-health/1', connection: 'close' },
      };
      const request = url.protocol === 'https:'
        ? https.request({ ...base, servername: url.hostname })
        : http.request(base);
      const timer = setTimeout(() => request.destroy(new Error('Health check timed out')), timeoutMs);
      timer.unref();
      request.once('response', (response) => {
        clearTimeout(timer);
        const status = response.statusCode ?? 0;
        response.resume();
        resolve(status);
      });
      request.once('error', (error) => { clearTimeout(timer); reject(error); });
      request.end();
    });
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

function buildHealthUrl(project: ProjectRecord): URL {
  if (project.domain === undefined || project.health.path === undefined) throw new ValidationError('HTTP health check requires project domain and health path');
  const hostname=project.domain.toLowerCase();
  if (hostname.includes('@') || hostname.includes('/') || hostname.includes(':')) throw new ValidationError('Project domain must be a hostname only');
  if (hostname==='localhost'||hostname.endsWith('.localhost')||hostname==='metadata.google.internal') throw new ValidationError('Private or local HTTP health targets are not allowed');
  const literal = net.isIP(hostname);
  if ((literal === 4 || literal === 6) && !isPublicNetworkAddress(hostname, literal)) throw new ValidationError('Private or local HTTP health targets are not allowed');
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

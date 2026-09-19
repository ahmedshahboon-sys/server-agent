import { createHash, randomUUID } from 'node:crypto';
import type { Authorizer, ProjectStore } from '../core/interfaces.js';
import type { Principal, ProjectPermission } from '../core/types.js';
import { AuthorizationError, ValidationError } from '../core/errors.js';
import type { SqliteDatabase } from '../database/sqlite.js';
import { withIdempotencyKey } from '../idempotency/context.js';
import { redactError, redactValue } from '../security/redaction.js';
import type { MutationGuard } from '../maintenance/maintenance-service.js';

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface McpToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
}

export interface ToolCallContext {
  readonly principal: Principal;
  readonly requestId: string | number | null;
}

export interface ToolRegistration {
  readonly definition: McpToolDefinition;
  readonly permission: ProjectPermission;
  readonly projectArgument?: string;
  readonly requiresGlobalScope?: boolean;
  readonly skipProjectCapabilityCheck?: boolean;
  readonly mutating?: boolean;
  readonly handler: (argumentsValue: Readonly<Record<string, unknown>>, context: ToolCallContext) => Promise<unknown>;
}

function requestIdText(value: string | number | null): string | null { return value === null ? null : String(value).slice(0, 128); }
function derivedIdempotencyKey(context:ToolCallContext,args:Readonly<Record<string,unknown>>):string|undefined{
  const explicit=args['idempotency_key'];
  if(explicit!==undefined){if(typeof explicit!=='string'||explicit.trim()==='')throw new ValidationError('idempotency_key must be a non-empty string');return explicit;}
  const request=requestIdText(context.requestId);if(request===null)return undefined;
  return `req:${createHash('sha256').update(`${context.principal.id}\0${request}`).digest('hex').slice(0,48)}`;
}

export class McpToolRegistry {
  private readonly registrations = new Map<string, ToolRegistration>();

  public constructor(private readonly authorizer: Authorizer, private readonly db?: SqliteDatabase, private readonly projects?: ProjectStore, private readonly mutationGuard?:MutationGuard) {}

  public register(registration: ToolRegistration): void {
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(registration.definition.name)) throw new ValidationError('MCP tool name is invalid');
    if (this.registrations.has(registration.definition.name)) throw new ValidationError(`Duplicate MCP tool ${registration.definition.name}`);
    this.registrations.set(registration.definition.name, registration);
  }

  public has(name: string): boolean { return this.registrations.has(name); }

  public assertAdditional(principal: Principal, permission: ProjectPermission, projectId?: string, requireGlobalScope = false): void {
    if (requireGlobalScope && !principal.projectScopes.includes('*')) throw new AuthorizationError();
    this.authorizer.assertAllowed(principal, permission, projectId);
  }

  public list(principal: Principal): readonly McpToolDefinition[] {
    return [...this.registrations.values()]
      .filter((item) => principal.permissions.includes(item.permission))
      .filter((item) => item.requiresGlobalScope !== true || principal.projectScopes.includes('*'))
      .map((item) => item.definition)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  public async call(name: string, argumentsValue: unknown, context: ToolCallContext): Promise<unknown> {
    const registration = this.registrations.get(name);
    if (registration === undefined) throw new ValidationError('Unknown MCP tool');
    const args = this.argumentsRecord(argumentsValue);
    let projectId: string | undefined;
    if (registration.projectArgument !== undefined) {
      const candidate = args[registration.projectArgument];
      if (typeof candidate !== 'string' || candidate.trim() === '') throw new ValidationError(`${registration.projectArgument} is required`);
      projectId = candidate;
    }
    try {
      if (registration.requiresGlobalScope === true && !context.principal.projectScopes.includes('*')) throw new AuthorizationError();
      this.authorizer.assertAllowed(context.principal, registration.permission, projectId);
      if (projectId !== undefined && this.projects !== undefined && registration.skipProjectCapabilityCheck !== true) {
        const project = this.projects.get(projectId);
        if (project === null || !project.enabled) throw new ValidationError('Project is not available');
        if (!project.permissions.includes(registration.permission)) throw new AuthorizationError(`Project does not permit ${registration.permission}`);
      }
      if (registration.mutating === true) this.mutationGuard?.assertMutationAllowed();
      const key=derivedIdempotencyKey(context,args);
      const result = await withIdempotencyKey(key,()=>registration.handler(args, context));
      this.audit(context, name, projectId, true, null);
      return redactValue(result);
    } catch (error) {
      const safe = redactError(error);
      this.audit(context, name, projectId, false, typeof safe['code'] === 'string' ? safe['code'] : 'TOOL_ERROR');
      throw error;
    }
  }

  private argumentsRecord(value: unknown): Readonly<Record<string, unknown>> {
    if (value === undefined) return {};
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Tool arguments must be an object');
    return value as Readonly<Record<string, unknown>>;
  }

  private audit(context: ToolCallContext, toolName: string, projectId: string | undefined, success: boolean, errorCode: string | null): void {
    if (this.db === undefined) return;
    this.db.raw.prepare('INSERT INTO mcp_audit(audit_id,request_id,principal_id,tool_name,project_id,success,error_code,created_at,credential_id) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), requestIdText(context.requestId), context.principal.id.slice(0, 128), toolName, projectId ?? null, success ? 1 : 0, errorCode, new Date().toISOString(), context.principal.credentialId ?? null);
  }
}

import type { Principal, ProjectPermission } from '../core/types.js';
import { AuthenticationError, ValidationError } from '../core/errors.js';
import { PROJECT_PERMISSION_SET } from '../security/permissions.js';

export interface RuntimeAuthentication {
  readonly token: string;
  readonly credentialId: string;
  readonly expiresAt: string | null;
  readonly principal: Principal;
}

function csv(value: string | undefined, name: string): readonly string[] {
  if (value === undefined || value.trim() === '') throw new ValidationError(`${name} is required`);
  const items = [...new Set(value.split(',').map((item) => item.trim()).filter((item) => item.length > 0))];
  if (items.length === 0) throw new ValidationError(`${name} is required`);
  return items;
}

function projectScopes(value: string | undefined): readonly string[] {
  const scopes = csv(value, 'SERVER_AGENT_MCP_PROJECT_SCOPES');
  for (const scope of scopes) {
    if (scope !== '*' && !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(scope)) throw new ValidationError('SERVER_AGENT_MCP_PROJECT_SCOPES contains an invalid project id');
  }
  return scopes;
}

function permissions(value: string | undefined): readonly ProjectPermission[] {
  const entries = csv(value, 'SERVER_AGENT_MCP_PERMISSIONS');
  for (const entry of entries) {
    if (!PROJECT_PERMISSION_SET.has(entry as ProjectPermission)) throw new ValidationError(`Unknown MCP permission ${entry}`);
  }
  return entries as ProjectPermission[];
}

function expiry(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new ValidationError('SERVER_AGENT_MCP_CREDENTIAL_EXPIRES_AT must be an ISO timestamp');
  return parsed.toISOString();
}

export function loadRuntimeAuthentication(env: NodeJS.ProcessEnv = process.env): RuntimeAuthentication {
  const token = env.SERVER_AGENT_MCP_BEARER_TOKEN;
  if (token === undefined || token.length < 32 || token.length > 4096) {
    throw new AuthenticationError('SERVER_AGENT_MCP_BEARER_TOKEN must contain 32-4096 characters');
  }
  const id = env.SERVER_AGENT_MCP_PRINCIPAL_ID ?? 'chatgpt-remote';
  if (!/^[A-Za-z0-9._:-]{2,128}$/.test(id)) throw new ValidationError('SERVER_AGENT_MCP_PRINCIPAL_ID is invalid');
  const credentialId = env.SERVER_AGENT_MCP_CREDENTIAL_ID ?? 'bootstrap-chatgpt';
  if (!/^[A-Za-z0-9._:-]{2,128}$/.test(credentialId)) throw new ValidationError('SERVER_AGENT_MCP_CREDENTIAL_ID is invalid');
  return {
    token,
    credentialId,
    expiresAt: expiry(env.SERVER_AGENT_MCP_CREDENTIAL_EXPIRES_AT),
    principal: {
      id,
      kind: 'remote',
      projectScopes: projectScopes(env.SERVER_AGENT_MCP_PROJECT_SCOPES),
      permissions: permissions(env.SERVER_AGENT_MCP_PERMISSIONS),
    },
  };
}


export function loadOptionalRuntimeAuthentication(env: NodeJS.ProcessEnv = process.env): RuntimeAuthentication | null {
  const token = env.SERVER_AGENT_MCP_BEARER_TOKEN;
  if (token === undefined || token.trim() === '') return null;
  return loadRuntimeAuthentication(env);
}

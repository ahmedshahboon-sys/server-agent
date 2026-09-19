import type { Principal, ProjectPermission } from '../core/types.js';
import { AuthenticationError, ValidationError } from '../core/errors.js';
import { PROJECT_PERMISSION_SET } from '../security/permissions.js';

const SAFE_OAUTH_PERMISSIONS = new Set<ProjectPermission>([
  'project:read',
  'files:read',
  'git:read',
  'tasks:read',
  'database:read',
  'deploy:read',
  'health:read',
  'logs:read',
  'service:read',
  'recovery:read',
  'rollback:read',
]);

export interface OAuthConfig {
  readonly publicBaseUrl: string;
  readonly issuer: string;
  readonly resource: string;
  readonly ownerSecret: string;
  readonly principal: Principal;
  readonly scope: string;
  readonly allowedRedirectOrigins: readonly string[];
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
}

function strictBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ValidationError(`${name} must be true or false`);
}

function csv(value: string | undefined, name: string): readonly string[] {
  if (value === undefined || value.trim() === '') throw new ValidationError(`${name} is required`);
  const items = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  if (items.length === 0) throw new ValidationError(`${name} is required`);
  return items;
}

function positiveInt(value: string | undefined, fallback: number, name: string, maximum: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 60 || parsed > maximum) throw new ValidationError(`${name} is invalid`);
  return parsed;
}

function httpsOrigin(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') throw new ValidationError(`${name} is required when OAuth is enabled`);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new ValidationError(`${name} must be a valid HTTPS origin`); }
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== '') {
    throw new ValidationError(`${name} must be an HTTPS origin without a path, query, credentials, or fragment`);
  }
  return parsed.origin;
}

function redirectOrigins(value: string | undefined): readonly string[] {
  const raw = value === undefined || value.trim() === '' ? ['https://chatgpt.com'] : csv(value, 'SERVER_AGENT_OAUTH_ALLOWED_REDIRECT_ORIGINS');
  return raw.map((item) => {
    let parsed: URL;
    try { parsed = new URL(item); } catch { throw new ValidationError('SERVER_AGENT_OAUTH_ALLOWED_REDIRECT_ORIGINS contains an invalid origin'); }
    const loopback = (parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === 'localhost') && parsed.protocol === 'http:';
    if ((!loopback && parsed.protocol !== 'https:') || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== '') {
      throw new ValidationError('OAuth redirect origins must be HTTPS origins, except HTTP loopback origins');
    }
    return parsed.origin;
  });
}

function projectScopes(value: string | undefined): readonly string[] {
  const scopes = csv(value, 'SERVER_AGENT_OAUTH_PROJECT_SCOPES');
  for (const scope of scopes) if (scope !== '*' && !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(scope)) {
    throw new ValidationError('SERVER_AGENT_OAUTH_PROJECT_SCOPES contains an invalid project id');
  }
  if (scopes.includes('*')) throw new ValidationError('OAuth project scope must be explicit; global * scope is not allowed');
  return scopes;
}

function permissions(value: string | undefined): readonly ProjectPermission[] {
  const entries = csv(value, 'SERVER_AGENT_OAUTH_PERMISSIONS');
  for (const entry of entries) {
    if (!PROJECT_PERMISSION_SET.has(entry as ProjectPermission)) throw new ValidationError(`Unknown OAuth permission ${entry}`);
    if (!SAFE_OAUTH_PERMISSIONS.has(entry as ProjectPermission)) throw new ValidationError(`OAuth permission ${entry} is not allowed in the read-only ChatGPT profile`);
  }
  return entries as readonly ProjectPermission[];
}

export function loadOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig | null {
  const enabled = strictBoolean(env.SERVER_AGENT_OAUTH_ENABLED, false, 'SERVER_AGENT_OAUTH_ENABLED');
  if (!enabled) return null;

  const publicBaseUrl = httpsOrigin(env.SERVER_AGENT_PUBLIC_BASE_URL, 'SERVER_AGENT_PUBLIC_BASE_URL');
  const ownerSecret = env.SERVER_AGENT_OAUTH_OWNER_SECRET;
  if (ownerSecret === undefined || ownerSecret.length < 32 || ownerSecret.length > 4096 || ownerSecret === 'CHANGE_ME_WITH_32_PLUS_RANDOM_CHARACTERS') {
    throw new AuthenticationError('SERVER_AGENT_OAUTH_OWNER_SECRET must contain 32-4096 non-placeholder characters');
  }

  const id = env.SERVER_AGENT_OAUTH_PRINCIPAL_ID ?? 'chatgpt-oauth';
  if (!/^[A-Za-z0-9._:-]{2,128}$/.test(id)) throw new ValidationError('SERVER_AGENT_OAUTH_PRINCIPAL_ID is invalid');
  const scope = env.SERVER_AGENT_OAUTH_SCOPE?.trim() || 'mcp:read';
  if (!/^[A-Za-z0-9._~:+\/-]{1,128}$/.test(scope)) throw new ValidationError('SERVER_AGENT_OAUTH_SCOPE is invalid');

  return {
    publicBaseUrl,
    issuer: publicBaseUrl,
    resource: publicBaseUrl,
    ownerSecret,
    scope,
    allowedRedirectOrigins: redirectOrigins(env.SERVER_AGENT_OAUTH_ALLOWED_REDIRECT_ORIGINS),
    accessTokenTtlSeconds: positiveInt(env.SERVER_AGENT_OAUTH_ACCESS_TOKEN_TTL_SECONDS, 3600, 'SERVER_AGENT_OAUTH_ACCESS_TOKEN_TTL_SECONDS', 86_400),
    refreshTokenTtlSeconds: positiveInt(env.SERVER_AGENT_OAUTH_REFRESH_TOKEN_TTL_SECONDS, 2_592_000, 'SERVER_AGENT_OAUTH_REFRESH_TOKEN_TTL_SECONDS', 31_536_000),
    principal: {
      id,
      kind: 'remote',
      projectScopes: projectScopes(env.SERVER_AGENT_OAUTH_PROJECT_SCOPES),
      permissions: permissions(env.SERVER_AGENT_OAUTH_PERMISSIONS),
    },
  };
}

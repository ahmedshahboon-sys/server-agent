import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SqliteDatabase } from '../database/sqlite.js';
import type { AuthenticationStore } from '../security/auth-store.js';
import { FixedWindowRateLimiter } from '../mcp/auth.js';
import type { OAuthConfig } from './config.js';

export interface OAuthHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
  readonly remoteAddress?: string;
}

export interface OAuthHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

type ClientRow = {
  client_id: string;
  redirect_uris_json: string;
  client_name: string | null;
  created_at: string;
};

type CodeRow = {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
  expires_at: string;
  used_at: string | null;
};

type RefreshRow = {
  refresh_hash: string;
  client_id: string;
  principal_id: string;
  scope: string;
  resource: string;
  expires_at: string;
  revoked_at: string | null;
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } as const;
const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const;

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function b64urlSha256(value: string): string { return createHash('sha256').update(value, 'ascii').digest('base64url'); }
function token(prefix: string): string { return `${prefix}_${randomBytes(32).toString('base64url')}`; }
function nowIso(): string { return new Date().toISOString(); }

function json(status: number, value: unknown, extra: Readonly<Record<string, string>> = {}): OAuthHttpResponse {
  return { status, headers: { ...JSON_HEADERS, ...extra }, body: JSON.stringify(value) };
}
function html(status: number, body: string): OAuthHttpResponse { return { status, headers: HTML_HEADERS, body }; }
function redirect(location: string): OAuthHttpResponse {
  return { status: 302, headers: { location, 'cache-control': 'no-store' }, body: '' };
}
function seeOther(location: string): OAuthHttpResponse {
  return {
    status: 303,
    headers: {
      location,
      'cache-control': 'no-store',
      pragma: 'no-cache',
      'referrer-policy': 'no-referrer',
    },
    body: '',
  };
}
function escapeHtml(value: string): string {
  return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
}
function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}
function parseForm(body: string): URLSearchParams { return new URLSearchParams(body); }
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return [];
  return [...new Set(value as string[])];
}

function normalizedScope(value: string, baseScope: string): string | null {
  const parts = [...new Set(value.split(/\s+/).map((item) => item.trim()).filter(Boolean))];
  if (!parts.includes(baseScope)) return null;
  if (parts.some((item) => item !== baseScope && item !== 'offline_access')) return null;
  return parts.includes('offline_access') ? `${baseScope} offline_access` : baseScope;
}

export class OAuthService {
  private readonly loginAttempts = new FixedWindowRateLimiter(10, 60_000, 1024);
  private readonly registrationAttempts = new FixedWindowRateLimiter(20, 60_000, 1024);

  public constructor(
    private readonly db: SqliteDatabase,
    private readonly authStore: AuthenticationStore,
    public readonly config: OAuthConfig,
  ) {
    this.pruneExpired();
  }

  public protectedResourceMetadataUrl(): string { return `${this.config.publicBaseUrl}/.well-known/oauth-protected-resource`; }
  public authorizationChallenge(): string {
    return `Bearer resource_metadata="${this.protectedResourceMetadataUrl()}", scope="${this.config.scope}"`;
  }

  public handle(request: OAuthHttpRequest): OAuthHttpResponse | null {
    const parsed = new URL(request.path, this.config.publicBaseUrl);
    const route = parsed.pathname;

    if (request.method === 'GET' && (route === '/.well-known/oauth-protected-resource' || route === '/.well-known/oauth-protected-resource/mcp')) {
      return json(200, {
        resource: this.config.resource,
        authorization_servers: [this.config.issuer],
        scopes_supported: [this.config.scope],
      });
    }
    if (request.method === 'GET' && route === '/.well-known/oauth-authorization-server') return this.authorizationServerMetadata();
    if (request.method === 'POST' && route === '/oauth/register') return this.register(request);
    if (route === '/oauth/authorize' && request.method === 'GET') return this.authorizeGet(parsed);
    if (route === '/oauth/authorize' && request.method === 'POST') return this.authorizePost(request);
    if (request.method === 'POST' && route === '/oauth/token') return this.token(request);
    return null;
  }

  private authorizationServerMetadata(): OAuthHttpResponse {
    return json(200, {
      issuer: this.config.issuer,
      authorization_endpoint: `${this.config.issuer}/oauth/authorize`,
      token_endpoint: `${this.config.issuer}/oauth/token`,
      registration_endpoint: `${this.config.issuer}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code','refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [this.config.scope, 'offline_access'],
      authorization_response_iss_parameter_supported: true,
    });
  }

  private register(request: OAuthHttpRequest): OAuthHttpResponse {
    const source = request.remoteAddress?.trim() || 'unknown';
    if (!this.registrationAttempts.consume(source)) return this.oauthJsonError(429, 'temporarily_unavailable', 'Too many client registrations');
    this.pruneExpired();
    this.pruneOrphanClients();

    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(request.body) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return this.oauthJsonError(400, 'invalid_client_metadata', 'Registration body must be a JSON object');
      payload = parsed as Record<string, unknown>;
    } catch {
      return this.oauthJsonError(400, 'invalid_client_metadata', 'Registration body must be valid JSON');
    }

    const redirectUris = stringArray(payload['redirect_uris']);
    if (redirectUris.length === 0 || redirectUris.length > 8) return this.oauthJsonError(400, 'invalid_redirect_uri', 'One or more redirect_uris are required');
    for (const uri of redirectUris) {
      let parsed: URL;
      try { parsed = new URL(uri); } catch { return this.oauthJsonError(400, 'invalid_redirect_uri', 'Redirect URI is invalid'); }
      if (!this.config.allowedRedirectOrigins.includes(parsed.origin) || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
        return this.oauthJsonError(400, 'invalid_redirect_uri', 'Redirect URI origin is not allowed');
      }
    }

    const method = typeof payload['token_endpoint_auth_method'] === 'string' ? payload['token_endpoint_auth_method'] : 'none';
    if (method !== 'none') return this.oauthJsonError(400, 'invalid_client_metadata', 'Only public clients using token_endpoint_auth_method=none are supported');
    const grantTypes = stringArray(payload['grant_types']);
    if (grantTypes.length > 0 && grantTypes.some((grant) => !['authorization_code','refresh_token'].includes(grant))) {
      return this.oauthJsonError(400, 'invalid_client_metadata', 'Unsupported grant type');
    }
    const responseTypes = stringArray(payload['response_types']);
    if (responseTypes.length > 0 && responseTypes.some((type) => type !== 'code')) {
      return this.oauthJsonError(400, 'invalid_client_metadata', 'Unsupported response type');
    }

    const clientId = `dcr_${randomBytes(24).toString('base64url')}`;
    const createdAt = nowIso();
    const clientName = typeof payload['client_name'] === 'string' ? payload['client_name'].slice(0, 256) : null;
    this.db.raw.prepare('INSERT INTO oauth_clients(client_id,redirect_uris_json,client_name,created_at) VALUES(?,?,?,?)')
      .run(clientId, JSON.stringify(redirectUris), clientName, createdAt);

    return json(201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(new Date(createdAt).getTime() / 1000),
      redirect_uris: redirectUris,
      grant_types: ['authorization_code','refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: typeof payload['application_type'] === 'string' ? payload['application_type'] : 'web',
      client_name: clientName ?? 'ChatGPT MCP Client',
      scope: `${this.config.scope} offline_access`,
    });
  }

  private authorizeGet(url: URL): OAuthHttpResponse {
    const validated = this.validateAuthorizeParams(url.searchParams);
    if ('response' in validated) return validated.response;
    const p = validated.params;
    const hidden = [...p.entries()].map(([key,value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`).join('');
    const client = this.client(p.get('client_id') ?? '');
    const clientName = client?.client_name ?? 'ChatGPT';
    return html(200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Server Agent authorization</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 20px;background:#111;color:#eee}form{background:#1d1d1d;padding:24px;border-radius:14px}input[type=password]{width:100%;box-sizing:border-box;padding:12px;margin:12px 0 18px;border-radius:8px;border:1px solid #555;background:#111;color:#fff}button{padding:12px 18px;border:0;border-radius:8px;font-weight:700;cursor:pointer}small{color:#aaa}</style></head><body><h1>Authorize Server Agent</h1><p><strong>${escapeHtml(clientName)}</strong> is requesting read-only access to the configured Server Agent projects.</p><p>OAuth scope: <code>${escapeHtml(p.get('scope') || this.config.scope)}</code></p><form method="post" action="/oauth/authorize">${hidden}<label>Owner authorization secret<input type="password" name="owner_secret" required autocomplete="current-password"></label><button type="submit">Authorize</button></form><p><small>No password is sent to ChatGPT. It is checked only by this Server Agent instance.</small></p></body></html>`);
  }

  private authorizePost(request: OAuthHttpRequest): OAuthHttpResponse {
    const source = request.remoteAddress?.trim() || 'unknown';
    if (this.loginAttempts.isBlocked(source)) return html(429, '<!doctype html><title>Too many attempts</title><p>Too many authorization attempts. Try again later.</p>');
    const form = parseForm(request.body);
    const validated = this.validateAuthorizeParams(form);
    if ('response' in validated) return validated.response;
    const secret = form.get('owner_secret') ?? '';
    if (!safeEqual(secret, this.config.ownerSecret)) {
      this.loginAttempts.consume(source);
      return html(401, '<!doctype html><title>Authorization failed</title><p>Invalid owner authorization secret.</p>');
    }

    const clientId = form.get('client_id') ?? '';
    const redirectUri = form.get('redirect_uri') ?? '';
    const codeChallenge = form.get('code_challenge') ?? '';
    const state = form.get('state') ?? '';
    const scope = form.get('scope') || this.config.scope;
    const resource = form.get('resource') || this.config.resource;
    const code = token('sa_code');
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();

    this.db.raw.prepare(`INSERT INTO oauth_authorization_codes(
      code_hash,client_id,redirect_uri,code_challenge,scope,resource,expires_at,used_at,created_at
    ) VALUES(?,?,?,?,?,?,?,NULL,?)`).run(digest(code), clientId, redirectUri, codeChallenge, scope, resource, expiresAt, nowIso());

    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    if (state !== '') target.searchParams.set('state', state);
    target.searchParams.set('iss', this.config.issuer);
    const callback = escapeHtml(target.toString());
    return html(200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorization complete</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 20px;background:#111;color:#eee}.card{background:#1d1d1d;padding:24px;border-radius:14px}a{display:inline-block;padding:12px 18px;border-radius:8px;background:#fff;color:#111;text-decoration:none;font-weight:700}small{color:#aaa}</style></head><body><h1>Authorization approved</h1><div class="card"><p>Continue to ChatGPT to finish connecting Server Agent.</p><p><a href="${callback}" rel="noreferrer">Continue to ChatGPT</a></p></div><p><small>This one-time authorization code expires shortly.</small></p></body></html>`);
  }

  private validateAuthorizeParams(params: URLSearchParams): { params: URLSearchParams } | { response: OAuthHttpResponse } {
    const responseType = params.get('response_type');
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    const state = params.get('state') ?? '';
    const codeChallenge = params.get('code_challenge') ?? '';
    const codeChallengeMethod = params.get('code_challenge_method');
    const requestedScope = params.get('scope') || this.config.scope;
    const scope = normalizedScope(requestedScope, this.config.scope);
    const resource = params.get('resource') || this.config.resource;

    const client = this.client(clientId);
    if (client === null) return { response: this.oauthPageError(400, 'invalid_client', 'Unknown OAuth client') };
    const allowed = JSON.parse(client.redirect_uris_json) as string[];
    if (!allowed.includes(redirectUri)) return { response: this.oauthPageError(400, 'invalid_request', 'redirect_uri does not match client registration') };

    const fail = (error: string, description: string): { response: OAuthHttpResponse } => {
      const target = new URL(redirectUri);
      target.searchParams.set('error', error);
      target.searchParams.set('error_description', description);
      if (state !== '') target.searchParams.set('state', state);
      target.searchParams.set('iss', this.config.issuer);
      return { response: redirect(target.toString()) };
    };

    if (responseType !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported');
    if (codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) return fail('invalid_request', 'PKCE S256 code_challenge is required');
    if (scope === null) return fail('invalid_scope', 'Requested OAuth scope is not supported');
    if (resource !== this.config.resource) return fail('invalid_target', 'OAuth resource does not match this Server Agent');
    const normalized = new URLSearchParams(params);
    normalized.set('scope', scope);
    return { params: normalized };
  }

  private token(request: OAuthHttpRequest): OAuthHttpResponse {
    const contentType = request.headers['content-type'] ?? request.headers['Content-Type'] ?? '';
    if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) return this.oauthJsonError(415, 'invalid_request', 'Token endpoint requires application/x-www-form-urlencoded');
    const form = parseForm(request.body);
    const grantType = form.get('grant_type');
    if (grantType === 'authorization_code') return this.exchangeAuthorizationCode(form);
    if (grantType === 'refresh_token') return this.exchangeRefreshToken(form);
    return this.oauthJsonError(400, 'unsupported_grant_type', 'Unsupported grant_type');
  }

  private exchangeAuthorizationCode(form: URLSearchParams): OAuthHttpResponse {
    const code = form.get('code') ?? '';
    const clientId = form.get('client_id') ?? '';
    const redirectUri = form.get('redirect_uri') ?? '';
    const verifier = form.get('code_verifier') ?? '';
    const resource = form.get('resource') || this.config.resource;
    if (code === '' || clientId === '' || redirectUri === '' || verifier === '') return this.oauthJsonError(400, 'invalid_request', 'code, client_id, redirect_uri, and code_verifier are required');

    const row = this.db.raw.prepare('SELECT code_hash,client_id,redirect_uri,code_challenge,scope,resource,expires_at,used_at FROM oauth_authorization_codes WHERE code_hash=?')
      .get(digest(code)) as unknown as CodeRow | undefined;
    if (row === undefined || row.used_at !== null || new Date(row.expires_at).getTime() <= Date.now()) return this.oauthJsonError(400, 'invalid_grant', 'Authorization code is invalid or expired');
    if (row.client_id !== clientId || row.redirect_uri !== redirectUri || row.resource !== resource || resource !== this.config.resource) return this.oauthJsonError(400, 'invalid_grant', 'Authorization code binding does not match');
    if (b64urlSha256(verifier) !== row.code_challenge) return this.oauthJsonError(400, 'invalid_grant', 'PKCE verification failed');

    const changed = this.db.raw.prepare('UPDATE oauth_authorization_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL').run(nowIso(), row.code_hash);
    if (Number(changed.changes) !== 1) return this.oauthJsonError(400, 'invalid_grant', 'Authorization code was already used');
    return this.issueTokens(clientId, row.scope, row.resource);
  }

  private exchangeRefreshToken(form: URLSearchParams): OAuthHttpResponse {
    const refresh = form.get('refresh_token') ?? '';
    const clientId = form.get('client_id') ?? '';
    const resource = form.get('resource') || this.config.resource;
    if (refresh === '' || clientId === '') return this.oauthJsonError(400, 'invalid_request', 'refresh_token and client_id are required');

    const row = this.db.raw.prepare('SELECT refresh_hash,client_id,principal_id,scope,resource,expires_at,revoked_at FROM oauth_refresh_tokens WHERE refresh_hash=?')
      .get(digest(refresh)) as unknown as RefreshRow | undefined;
    if (row === undefined || row.revoked_at !== null || new Date(row.expires_at).getTime() <= Date.now()) return this.oauthJsonError(400, 'invalid_grant', 'Refresh token is invalid or expired');
    if (row.client_id !== clientId || row.resource !== resource || resource !== this.config.resource || row.principal_id !== this.config.principal.id) {
      return this.oauthJsonError(400, 'invalid_grant', 'Refresh token binding does not match');
    }

    const revokedAt = nowIso();
    const changed = this.db.raw.prepare('UPDATE oauth_refresh_tokens SET revoked_at=? WHERE refresh_hash=? AND revoked_at IS NULL').run(revokedAt, row.refresh_hash);
    if (Number(changed.changes) !== 1) return this.oauthJsonError(400, 'invalid_grant', 'Refresh token was already used');
    return this.issueTokens(clientId, row.scope, row.resource);
  }

  private issueTokens(clientId: string, scope: string, resource: string): OAuthHttpResponse {
    if (this.client(clientId) === null) return this.oauthJsonError(400, 'invalid_client', 'Unknown OAuth client');
    const accessToken = token('sa_oauth');
    const credentialId = `oauth-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + this.config.accessTokenTtlSeconds * 1000).toISOString();
    this.authStore.createCredential(this.config.principal, credentialId, accessToken, expiresAt);

    const includeRefresh = scope.split(/\s+/).includes('offline_access');
    if (!includeRefresh) {
      return json(200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: this.config.accessTokenTtlSeconds,
        scope,
      });
    }

    const refreshToken = token('sa_refresh');
    const refreshExpiresAt = new Date(Date.now() + this.config.refreshTokenTtlSeconds * 1000).toISOString();
    this.db.raw.prepare(`INSERT INTO oauth_refresh_tokens(
      refresh_hash,client_id,principal_id,scope,resource,expires_at,revoked_at,created_at
    ) VALUES(?,?,?,?,?,?,NULL,?)`).run(digest(refreshToken), clientId, this.config.principal.id, scope, resource, refreshExpiresAt, nowIso());

    return json(200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope,
    });
  }

  private client(clientId: string): ClientRow | null {
    const row = this.db.raw.prepare('SELECT client_id,redirect_uris_json,client_name,created_at FROM oauth_clients WHERE client_id=?').get(clientId) as unknown as ClientRow | undefined;
    return row ?? null;
  }

  private oauthJsonError(status: number, error: string, description: string): OAuthHttpResponse {
    return json(status, { error, error_description: description });
  }

  private oauthPageError(status: number, error: string, description: string): OAuthHttpResponse {
    return html(status, `<!doctype html><html><head><meta charset="utf-8"><title>OAuth error</title></head><body><h1>${escapeHtml(error)}</h1><p>${escapeHtml(description)}</p></body></html>`);
  }

  private pruneExpired(): void {
    const now = nowIso();
    this.db.raw.prepare('DELETE FROM oauth_authorization_codes WHERE expires_at < ? OR used_at IS NOT NULL').run(now);
    this.db.raw.prepare('DELETE FROM oauth_refresh_tokens WHERE expires_at < ?').run(now);
  }

  private pruneOrphanClients(): void {
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    this.db.raw.prepare(`
      DELETE FROM oauth_clients
      WHERE created_at < ?
        AND client_id NOT IN (SELECT client_id FROM oauth_authorization_codes)
        AND client_id NOT IN (SELECT client_id FROM oauth_refresh_tokens)
    `).run(cutoff);
  }
}

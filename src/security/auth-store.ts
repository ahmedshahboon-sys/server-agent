import { createHash, randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../database/sqlite.js';
import type { Principal, ProjectPermission } from '../core/types.js';
import { AuthenticationError, ConflictError, ValidationError } from '../core/errors.js';
import { PROJECT_PERMISSION_SET } from './permissions.js';

export interface StoredCredentialSummary {
  readonly credentialId: string;
  readonly principalId: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface CredentialJoinRow {
  readonly credential_id: string;
  readonly principal_id: string;
  readonly token_hash: string;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
  readonly last_used_at: string | null;
  readonly principal_kind: Principal['kind'];
  readonly project_scopes_json: string;
  readonly permissions_json: string;
  readonly principal_enabled: number;
}

const PRINCIPAL_ID = /^[A-Za-z0-9._:-]{2,128}$/;
const CREDENTIAL_ID = /^[A-Za-z0-9._:-]{2,128}$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export function bearerTokenHash(token: string): string {
  if (token.length < 32 || token.length > 4096) throw new AuthenticationError('Bearer credential must contain 32-4096 characters');
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function validatePrincipal(principal: Principal): void {
  if (!PRINCIPAL_ID.test(principal.id)) throw new ValidationError('Principal id is invalid');
  if (principal.kind !== 'remote') throw new ValidationError('Persisted MCP principals must be remote principals');
  if (principal.projectScopes.length === 0) throw new ValidationError('Principal project scopes are required');
  for (const scope of principal.projectScopes) if (scope !== '*' && !PROJECT_ID.test(scope)) throw new ValidationError('Principal contains an invalid project scope');
  if (principal.permissions.length === 0) throw new ValidationError('Principal permissions are required');
  for (const permission of principal.permissions) if (!PROJECT_PERMISSION_SET.has(permission)) throw new ValidationError(`Unknown principal permission ${permission}`);
}

function normalizeExpiry(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new ValidationError('Credential expiry must be an ISO timestamp');
  return parsed.toISOString();
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export class AuthenticationStore {
  public constructor(private readonly db: SqliteDatabase) {}

  public bootstrapCredential(principal: Principal, credentialId: string, token: string, expiresAt?: string | null): StoredCredentialSummary {
    validatePrincipal(principal);
    if (!CREDENTIAL_ID.test(credentialId)) throw new ValidationError('Credential id is invalid');
    const hash = bearerTokenHash(token);
    const expiry = normalizeExpiry(expiresAt);
    const existing = this.credentialRow(credentialId);
    if (existing !== null) {
      if (existing.principal_id !== principal.id || existing.token_hash !== hash || existing.expires_at !== expiry) {
        throw new ConflictError('Bootstrap credential id already exists with different material; rotate with a new credential id');
      }
      this.assertPrincipalMatches(principal);
      return this.summary(existing);
    }

    const now = new Date().toISOString();
    this.db.raw.exec('BEGIN IMMEDIATE;');
    try {
      this.ensurePrincipal(principal, now);
      this.db.raw.prepare(
        'INSERT INTO auth_credentials(credential_id,principal_id,token_hash,expires_at,revoked_at,last_used_at,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,?,?)',
      ).run(credentialId, principal.id, hash, expiry, now, now);
      this.db.raw.exec('COMMIT;');
    } catch (error) {
      this.db.raw.exec('ROLLBACK;');
      throw error;
    }
    const created = this.credentialRow(credentialId);
    if (created === null) throw new Error('Credential creation failed');
    return this.summary(created);
  }

  public createCredential(principal: Principal, credentialId: string, token: string, expiresAt?: string | null): StoredCredentialSummary {
    validatePrincipal(principal);
    if (!CREDENTIAL_ID.test(credentialId)) throw new ValidationError('Credential id is invalid');
    if (this.credentialRow(credentialId) !== null) throw new ConflictError('Credential id already exists');
    const hash = bearerTokenHash(token);
    const expiry = normalizeExpiry(expiresAt);
    if (this.db.raw.prepare('SELECT 1 FROM auth_credentials WHERE token_hash=?').get(hash) !== undefined) throw new ConflictError('Credential token is already registered');
    const now = new Date().toISOString();
    this.db.raw.exec('BEGIN IMMEDIATE;');
    try {
      this.ensurePrincipal(principal, now);
      this.db.raw.prepare(
        'INSERT INTO auth_credentials(credential_id,principal_id,token_hash,expires_at,revoked_at,last_used_at,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,?,?)',
      ).run(credentialId, principal.id, hash, expiry, now, now);
      this.db.raw.exec('COMMIT;');
    } catch (error) {
      this.db.raw.exec('ROLLBACK;');
      throw error;
    }
    const created = this.credentialRow(credentialId);
    if (created === null) throw new Error('Credential creation failed');
    return this.summary(created);
  }

  public rotateCredential(oldCredentialId: string, newCredentialId: string, newToken: string, expiresAt?: string | null): StoredCredentialSummary {
    if (!CREDENTIAL_ID.test(oldCredentialId) || !CREDENTIAL_ID.test(newCredentialId)) throw new ValidationError('Credential id is invalid');
    if (oldCredentialId === newCredentialId) throw new ValidationError('Rotation requires a new credential id');
    const old = this.credentialRow(oldCredentialId);
    if (old === null) throw new ValidationError('Credential does not exist');
    if (old.revoked_at !== null) throw new ConflictError('Credential is already revoked');
    if (this.credentialRow(newCredentialId) !== null) throw new ConflictError('New credential id already exists');
    const hash = bearerTokenHash(newToken);
    if (this.db.raw.prepare('SELECT 1 FROM auth_credentials WHERE token_hash=?').get(hash) !== undefined) throw new ConflictError('Credential token is already registered');
    const expiry = normalizeExpiry(expiresAt);
    const now = new Date().toISOString();
    this.db.raw.exec('BEGIN IMMEDIATE;');
    try {
      this.db.raw.prepare(
        'INSERT INTO auth_credentials(credential_id,principal_id,token_hash,expires_at,revoked_at,last_used_at,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,?,?)',
      ).run(newCredentialId, old.principal_id, hash, expiry, now, now);
      this.db.raw.prepare('UPDATE auth_credentials SET revoked_at=?,updated_at=? WHERE credential_id=? AND revoked_at IS NULL').run(now, now, oldCredentialId);
      this.db.raw.exec('COMMIT;');
    } catch (error) {
      this.db.raw.exec('ROLLBACK;');
      throw error;
    }
    const created = this.credentialRow(newCredentialId);
    if (created === null) throw new Error('Credential rotation failed');
    return this.summary(created);
  }

  public revokeCredential(credentialId: string): StoredCredentialSummary {
    if (!CREDENTIAL_ID.test(credentialId)) throw new ValidationError('Credential id is invalid');
    const existing = this.credentialRow(credentialId);
    if (existing === null) throw new ValidationError('Credential does not exist');
    if (existing.revoked_at === null) {
      const now = new Date().toISOString();
      this.db.raw.prepare('UPDATE auth_credentials SET revoked_at=?,updated_at=? WHERE credential_id=?').run(now, now, credentialId);
    }
    const updated = this.credentialRow(credentialId);
    if (updated === null) throw new Error('Credential revoke failed');
    return this.summary(updated);
  }

  public setPrincipalEnabled(principalId: string, enabled: boolean): void {
    if (!PRINCIPAL_ID.test(principalId)) throw new ValidationError('Principal id is invalid');
    const result = this.db.raw.prepare('UPDATE auth_principals SET enabled=?,updated_at=? WHERE principal_id=?').run(enabled ? 1 : 0, new Date().toISOString(), principalId);
    if (Number(result.changes) !== 1) throw new ValidationError('Principal does not exist');
  }

  public verify(token: string, now = new Date()): Principal {
    const hash = bearerTokenHash(token);
    const row = this.db.raw.prepare(
      `SELECT c.credential_id,c.principal_id,c.token_hash,c.expires_at,c.revoked_at,c.last_used_at,
              p.kind AS principal_kind,p.project_scopes_json,p.permissions_json,p.enabled AS principal_enabled
       FROM auth_credentials c JOIN auth_principals p ON p.principal_id=c.principal_id
       WHERE c.token_hash=?`,
    ).get(hash) as unknown as CredentialJoinRow | undefined;
    if (row === undefined) {
      this.audit(null, null, 'FAILURE', 'INVALID_CREDENTIAL', now);
      throw new AuthenticationError();
    }
    if (row.principal_enabled !== 1) {
      this.audit(row.principal_id, row.credential_id, 'FAILURE', 'PRINCIPAL_DISABLED', now);
      throw new AuthenticationError();
    }
    if (row.revoked_at !== null) {
      this.audit(row.principal_id, row.credential_id, 'FAILURE', 'CREDENTIAL_REVOKED', now);
      throw new AuthenticationError();
    }
    if (row.expires_at !== null && new Date(row.expires_at).getTime() <= now.getTime()) {
      this.audit(row.principal_id, row.credential_id, 'FAILURE', 'CREDENTIAL_EXPIRED', now);
      throw new AuthenticationError();
    }

    const projectScopes = uniqueStrings(JSON.parse(row.project_scopes_json) as string[]);
    const permissions = uniqueStrings(JSON.parse(row.permissions_json) as ProjectPermission[]) as readonly ProjectPermission[];
    const principal: Principal = {
      id: row.principal_id,
      kind: row.principal_kind,
      credentialId: row.credential_id,
      projectScopes,
      permissions,
    };
    validatePrincipal(principal);
    return principal;
  }

  public recordSuccessfulUse(principal: Principal, now = new Date()): void {
    if (principal.credentialId === undefined) throw new ValidationError('Authenticated principal is missing credential id');
    const usedAt = now.toISOString();
    this.db.raw.prepare('UPDATE auth_credentials SET last_used_at=?,updated_at=? WHERE credential_id=? AND principal_id=?')
      .run(usedAt, usedAt, principal.credentialId, principal.id);
    this.audit(principal.id, principal.credentialId, 'SUCCESS', null, now);
  }

  public authenticate(token: string, now = new Date()): Principal {
    const principal = this.verify(token, now);
    this.recordSuccessfulUse(principal, now);
    return principal;
  }

  public listCredentials(principalId?: string): readonly StoredCredentialSummary[] {
    const sql = principalId === undefined
      ? 'SELECT credential_id,principal_id,expires_at,revoked_at,last_used_at,created_at,updated_at FROM auth_credentials ORDER BY created_at,credential_id'
      : 'SELECT credential_id,principal_id,expires_at,revoked_at,last_used_at,created_at,updated_at FROM auth_credentials WHERE principal_id=? ORDER BY created_at,credential_id';
    const rows = (principalId === undefined ? this.db.raw.prepare(sql).all() : this.db.raw.prepare(sql).all(principalId)) as unknown as Array<{
      credential_id:string; principal_id:string; expires_at:string|null; revoked_at:string|null; last_used_at:string|null; created_at:string; updated_at:string;
    }>;
    return rows.map((row)=>({
      credentialId:row.credential_id,principalId:row.principal_id,expiresAt:row.expires_at,revokedAt:row.revoked_at,lastUsedAt:row.last_used_at,createdAt:row.created_at,updatedAt:row.updated_at,
    }));
  }

  public hasUsableCredential(now = new Date()): boolean {
    const rows = this.db.raw.prepare(
      'SELECT expires_at FROM auth_credentials c JOIN auth_principals p ON p.principal_id=c.principal_id WHERE c.revoked_at IS NULL AND p.enabled=1',
    ).all() as unknown as Array<{expires_at:string|null}>;
    return rows.some((row)=>row.expires_at === null || new Date(row.expires_at).getTime() > now.getTime());
  }

  public auditRateLimited(principalId: string | null, credentialId: string | null, now = new Date()): void {
    this.audit(principalId, credentialId, 'RATE_LIMITED', 'RATE_LIMITED', now);
  }

  public pruneAudit(retentionDays: number, now = new Date()): { readonly authEvents: number; readonly mcpEvents: number } {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new ValidationError('Audit retention days is invalid');
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    const auth = this.db.raw.prepare('DELETE FROM auth_audit WHERE created_at < ?').run(cutoff);
    const mcp = this.db.raw.prepare('DELETE FROM mcp_audit WHERE created_at < ?').run(cutoff);
    return { authEvents: Number(auth.changes), mcpEvents: Number(mcp.changes) };
  }

  private ensurePrincipal(principal: Principal, now: string): void {
    const existing = this.db.raw.prepare('SELECT kind,project_scopes_json,permissions_json,enabled FROM auth_principals WHERE principal_id=?').get(principal.id) as unknown as {
      kind:string; project_scopes_json:string; permissions_json:string; enabled:number;
    } | undefined;
    const scopes = JSON.stringify(uniqueStrings(principal.projectScopes));
    const permissions = JSON.stringify(uniqueStrings(principal.permissions));
    if (existing === undefined) {
      this.db.raw.prepare('INSERT INTO auth_principals(principal_id,kind,project_scopes_json,permissions_json,enabled,created_at,updated_at) VALUES(?,?,?,?,1,?,?)')
        .run(principal.id, principal.kind, scopes, permissions, now, now);
      return;
    }
    if (existing.kind !== principal.kind || existing.project_scopes_json !== scopes || existing.permissions_json !== permissions) {
      throw new ConflictError('Existing principal definition differs; change principal authorization separately before adding credentials');
    }
    if (existing.enabled !== 1) throw new ConflictError('Principal is disabled');
  }

  private assertPrincipalMatches(principal: Principal): void {
    const row = this.db.raw.prepare('SELECT kind,project_scopes_json,permissions_json FROM auth_principals WHERE principal_id=?').get(principal.id) as unknown as {
      kind:string; project_scopes_json:string; permissions_json:string;
    } | undefined;
    if (row === undefined || row.kind !== principal.kind || row.project_scopes_json !== JSON.stringify(uniqueStrings(principal.projectScopes)) || row.permissions_json !== JSON.stringify(uniqueStrings(principal.permissions))) {
      throw new ConflictError('Bootstrap principal definition does not match stored principal');
    }
  }

  private credentialRow(credentialId: string): {
    credential_id:string; principal_id:string; token_hash:string; expires_at:string|null; revoked_at:string|null; last_used_at:string|null; created_at:string; updated_at:string;
  } | null {
    const row = this.db.raw.prepare(
      'SELECT credential_id,principal_id,token_hash,expires_at,revoked_at,last_used_at,created_at,updated_at FROM auth_credentials WHERE credential_id=?',
    ).get(credentialId) as unknown as {
      credential_id:string; principal_id:string; token_hash:string; expires_at:string|null; revoked_at:string|null; last_used_at:string|null; created_at:string; updated_at:string;
    } | undefined;
    return row ?? null;
  }

  private summary(row:{credential_id:string;principal_id:string;expires_at:string|null;revoked_at:string|null;last_used_at:string|null;created_at:string;updated_at:string}):StoredCredentialSummary {
    return {credentialId:row.credential_id,principalId:row.principal_id,expiresAt:row.expires_at,revokedAt:row.revoked_at,lastUsedAt:row.last_used_at,createdAt:row.created_at,updatedAt:row.updated_at};
  }

  private audit(principalId:string|null,credentialId:string|null,outcome:string,reason:string|null,now:Date):void {
    this.db.raw.prepare('INSERT INTO auth_audit(audit_id,principal_id,credential_id,outcome,reason,created_at) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(),principalId,credentialId,outcome,reason,now.toISOString());
  }
}

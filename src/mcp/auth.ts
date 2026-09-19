import { createHash, timingSafeEqual } from 'node:crypto';
import type { Principal } from '../core/types.js';
import { AuthenticationError, RateLimitError, ValidationError } from '../core/errors.js';
import type { AuthenticationStore } from '../security/auth-store.js';

export interface AuthenticationRequest {
  readonly authorization?: string;
  readonly remoteAddress?: string;
  readonly origin?: string;
}

export interface McpAuthenticator {
  authenticate(request: AuthenticationRequest): Promise<Principal>;
}

function digest(value: string): Buffer { return createHash('sha256').update(value, 'utf8').digest(); }

export class RejectAllAuthenticator implements McpAuthenticator {
  public async authenticate(): Promise<Principal> { throw new AuthenticationError(); }
}

export class StaticBearerAuthenticator implements McpAuthenticator {
  private readonly expectedDigest: Buffer;

  public constructor(token: string, private readonly principal: Principal) {
    if (token.length < 24) throw new AuthenticationError('Configured bearer credential is too short');
    this.expectedDigest = digest(token);
  }

  public async authenticate(request: AuthenticationRequest): Promise<Principal> {
    const header = request.authorization;
    if (header === undefined || !header.startsWith('Bearer ')) throw new AuthenticationError();
    const candidate = header.slice('Bearer '.length);
    if (candidate.length === 0) throw new AuthenticationError();
    const actual = digest(candidate);
    if (!timingSafeEqual(this.expectedDigest, actual)) throw new AuthenticationError();
    return this.principal;
  }
}

interface WindowEntry { readonly startedAt: number; readonly count: number; }

export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, WindowEntry>();

  public constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 10_000,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new ValidationError('Rate limit must be a positive integer');
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new ValidationError('Rate-limit window must be a positive integer');
    if (!Number.isInteger(maxKeys) || maxKeys < 16) throw new ValidationError('Rate-limit key bound is invalid');
  }

  public consume(key: string): boolean {
    const current = this.now();
    const existing = this.entries.get(key);
    if (existing === undefined || current - existing.startedAt >= this.windowMs) {
      this.entries.set(key, { startedAt: current, count: 1 });
      this.prune(current);
      return true;
    }
    if (existing.count >= this.limit) return false;
    this.entries.set(key, { startedAt: existing.startedAt, count: existing.count + 1 });
    return true;
  }

  private prune(now: number): void {
    if (this.entries.size <= this.maxKeys) return;
    for (const [key, value] of this.entries) {
      if (now - value.startedAt >= this.windowMs) this.entries.delete(key);
      if (this.entries.size <= this.maxKeys) break;
    }
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export interface PersistentBearerAuthenticatorOptions {
  readonly attemptsPerMinute: number;
  readonly requestsPerMinute: number;
  readonly now?: () => Date;
}

export class PersistentBearerAuthenticator implements McpAuthenticator {
  private readonly attempts: FixedWindowRateLimiter;
  private readonly requests: FixedWindowRateLimiter;
  private readonly now: () => Date;

  public constructor(private readonly store: AuthenticationStore, options: PersistentBearerAuthenticatorOptions) {
    this.now = options.now ?? (() => new Date());
    const clock = (): number => this.now().getTime();
    this.attempts = new FixedWindowRateLimiter(options.attemptsPerMinute, 60_000, 10_000, clock);
    this.requests = new FixedWindowRateLimiter(options.requestsPerMinute, 60_000, 10_000, clock);
  }

  public async authenticate(request: AuthenticationRequest): Promise<Principal> {
    const now = this.now();
    const sourceKey = request.remoteAddress?.trim() || 'unknown';
    if (!this.attempts.consume(sourceKey)) {
      this.store.auditRateLimited(null, null, now);
      throw new RateLimitError();
    }

    const header = request.authorization;
    if (header === undefined || !header.startsWith('Bearer ')) throw new AuthenticationError();
    const candidate = header.slice('Bearer '.length);
    if (candidate.length === 0) throw new AuthenticationError();

    const principal = this.store.verify(candidate, now);
    if (!this.requests.consume(principal.id)) {
      this.store.auditRateLimited(principal.id, principal.credentialId ?? null, now);
      throw new RateLimitError();
    }
    this.store.recordSuccessfulUse(principal, now);
    return principal;
  }
}

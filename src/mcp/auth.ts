import { createHash, timingSafeEqual } from 'node:crypto';
import type { Principal } from '../core/types.js';
import { AuthenticationError } from '../core/errors.js';

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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { AuthorizationError } from '../../src/core/errors.js';
import type { Principal } from '../../src/core/types.js';

const principal: Principal = {
  id: 'chatgpt-session',
  kind: 'remote',
  projectScopes: ['project-a'],
  permissions: ['project:read', 'files:read'],
};

describe('DefaultDenyAuthorizer', () => {
  it('allows explicit project + permission scope', () => {
    assert.doesNotThrow(() => new DefaultDenyAuthorizer().assertAllowed(principal, 'files:read', 'project-a'));
  });

  it('denies a permission that was not explicitly granted', () => {
    assert.throws(() => new DefaultDenyAuthorizer().assertAllowed(principal, 'files:write', 'project-a'), AuthorizationError);
  });

  it('denies cross-project access even with the tool permission', () => {
    assert.throws(() => new DefaultDenyAuthorizer().assertAllowed(principal, 'files:read', 'project-b'), AuthorizationError);
  });
});

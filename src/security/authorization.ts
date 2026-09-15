import type { Authorizer } from '../core/interfaces.js';
import type { Principal, ProjectPermission } from '../core/types.js';
import { AuthorizationError } from '../core/errors.js';

export class DefaultDenyAuthorizer implements Authorizer {
  public assertAllowed(principal: Principal, permission: ProjectPermission, projectId?: string): void {
    if (!principal.permissions.includes(permission)) throw new AuthorizationError();
    if (projectId === undefined) return;
    if (!principal.projectScopes.includes(projectId) && !principal.projectScopes.includes('*')) {
      throw new AuthorizationError();
    }
  }
}

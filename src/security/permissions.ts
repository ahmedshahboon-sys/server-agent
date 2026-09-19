import type { ProjectPermission } from '../core/types.js';

export const PROJECT_MANAGEMENT_PERMISSIONS: readonly ProjectPermission[] = [
  'project:register',
  'project:update:metadata',
  'project:update:state',
  'project:update:root',
  'project:update:commands',
  'project:update:database',
  'project:update:deployment',
  'project:update:capabilities',
  'project:disable',
  'project:archive',
] as const;

export const PROJECT_CAPABILITY_PERMISSIONS: readonly ProjectPermission[] = [
  'project:read',
  'files:read',
  'files:write',
  'git:read',
  'git:write',
  'commands:run',
  'tasks:read',
  'tasks:write',
  'database:read',
  'database:write',
  'deploy:read',
  'deploy:run',
  'health:read',
  'logs:read',
  'service:read',
  'service:restart',
  'recovery:read',
  'recovery:run',
  'rollback:read',
  'rollback:run',
] as const;

export const ALL_PROJECT_PERMISSIONS: readonly ProjectPermission[] = [
  ...PROJECT_MANAGEMENT_PERMISSIONS,
  ...PROJECT_CAPABILITY_PERMISSIONS,
] as const;

export const PROJECT_PERMISSION_SET = new Set<ProjectPermission>(ALL_PROJECT_PERMISSIONS);
export const PROJECT_CAPABILITY_PERMISSION_SET = new Set<ProjectPermission>(PROJECT_CAPABILITY_PERMISSIONS);

export const PROJECT_REGISTRATION_PERMISSIONS: readonly ProjectPermission[] = [
  'project:register',
  'project:update:metadata',
  'project:update:state',
  'project:update:root',
  'project:update:commands',
  'project:update:database',
  'project:update:deployment',
  'project:update:capabilities',
] as const;

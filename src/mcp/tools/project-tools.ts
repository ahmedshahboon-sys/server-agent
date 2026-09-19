import { isDeepStrictEqual } from 'node:util';
import type { ProjectStore } from '../../core/interfaces.js';
import type { Principal, ProjectPermission, ProjectRecord } from '../../core/types.js';
import { ValidationError } from '../../core/errors.js';
import { PROJECT_CAPABILITY_PERMISSIONS, PROJECT_REGISTRATION_PERMISSIONS } from '../../security/permissions.js';
import { objectArg, projectInput, stringArg } from '../arguments.js';
import type { McpToolRegistry } from '../tool-registry.js';
import { objectSchema, projectIdSchema } from './schema-helpers.js';

const argvSchema = { type: 'array', items: { type: 'string', minLength: 1, maxLength: 4096 }, minItems: 1, maxItems: 64 } as const;
const healthSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['none','http','service','database','composite'] },
    scheme: { type: 'string', enum: ['http','https'] },
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    path: { type: 'string', minLength: 1, maxLength: 2048 },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 },
    expectedStatus: { type: 'array', items: { type: 'integer', minimum: 100, maximum: 599 }, minItems: 1, maxItems: 64 },
  },
  required: ['type'],
} as const;
const commandsSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    build: argvSchema, test: argvSchema, deploy: argvSchema, rollback: argvSchema,
    allowed: { type: 'object', additionalProperties: argvSchema, maxProperties: 128 },
    validation: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 64 }, maxItems: 64 },
  },
} as const;
const databaseSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    adapter: { type: 'string', enum: ['none','postgresql','mysql','sqlite','mongodb'] },
    secretRef: { type: 'string', minLength: 2, maxLength: 128 },
    defaultAccess: { type: 'string', enum: ['read','controlled-write'] },
    metadata: { type: 'object' },
  },
  required: ['adapter','defaultAccess'],
} as const;
const deploymentSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    strategy: { type: 'string', enum: ['none','command','restart-only'] },
    branch: { type: 'string', minLength: 1, maxLength: 128 },
    requireClean: { type: 'boolean' },
    validationRequired: { type: 'boolean' },
    restartService: { type: 'boolean' },
    healthRequired: { type: 'boolean' },
  },
  required: ['strategy','requireClean','validationRequired','restartService','healthRequired'],
} as const;

const projectProperties = {
  id: { type: 'string', minLength: 2, maxLength: 64 },
  name: { type: 'string', minLength: 1, maxLength: 256 },
  root: { type: 'string', minLength: 1, maxLength: 4096 },
  enabled: { type: 'boolean' },
  runtime: { type: 'string', enum: ['node', 'python', 'static', 'other'] },
  serviceName: { type: 'string', minLength: 1, maxLength: 256 },
  domain: { type: 'string', minLength: 1, maxLength: 512 },
  ports: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 65535 }, maxItems: 64 },
  health: healthSchema,
  commands: commandsSchema,
  database: databaseSchema,
  deployment: deploymentSchema,
  permissions: { type: 'array', items: { type: 'string', enum: PROJECT_CAPABILITY_PERMISSIONS }, maxItems: 64 },
  environmentRefs: { type: 'array', items: { type: 'string', minLength: 2, maxLength: 128 }, maxItems: 128 },
  metadata: { type: 'object' },
} as const;
const commonRequired = ['name','root','enabled','runtime','ports','health','commands','database','deployment','permissions','environmentRefs','metadata'] as const;
const createProjectPayload = { type:'object', additionalProperties:false, properties:projectProperties, required:['id',...commonRequired] } as const;
const updateProjectPayload = { type:'object', additionalProperties:false, properties:projectProperties, required:commonRequired } as const;

function withoutId(project: Omit<ProjectRecord, 'createdAt' | 'updatedAt'>): Omit<ProjectRecord, 'id' | 'createdAt' | 'updatedAt'> {
  const { id: _id, ...rest } = project;
  return rest;
}

function requireAdditional(registry:McpToolRegistry, principal:Principal, projectId:string, permission:ProjectPermission, global=false):void {
  registry.assertAdditional(principal, permission, projectId, global);
}

function assertRegistrationPrivileges(registry:McpToolRegistry, principal:Principal):void {
  for (const permission of PROJECT_REGISTRATION_PERMISSIONS) registry.assertAdditional(principal, permission, undefined, true);
}

function assertUpdatePrivileges(registry:McpToolRegistry, principal:Principal, current:ProjectRecord, next:Omit<ProjectRecord,'createdAt'|'updatedAt'>):void {
  const projectId=current.id;
  let changed=false;
  if (current.root !== next.root) { changed=true; requireAdditional(registry, principal, projectId, 'project:update:root', true); }
  if (!isDeepStrictEqual(current.permissions, next.permissions)) { changed=true; requireAdditional(registry, principal, projectId, 'project:update:capabilities', true); }
  if (!isDeepStrictEqual(current.commands, next.commands) || !isDeepStrictEqual(current.environmentRefs, next.environmentRefs)) { changed=true; requireAdditional(registry, principal, projectId, 'project:update:commands'); }
  if (!isDeepStrictEqual(current.database, next.database)) { changed=true; requireAdditional(registry, principal, projectId, 'project:update:database'); }
  if (
    !isDeepStrictEqual(current.deployment, next.deployment) ||
    !isDeepStrictEqual(current.health, next.health) ||
    !isDeepStrictEqual(current.ports, next.ports) ||
    current.serviceName !== next.serviceName ||
    current.domain !== next.domain
  ) { changed=true; requireAdditional(registry, principal, projectId, 'project:update:deployment'); }
  if (current.enabled !== next.enabled) { changed=true; requireAdditional(registry, principal, projectId, 'project:update:state'); }
  if (current.name !== next.name || current.runtime !== next.runtime || !isDeepStrictEqual(current.metadata, next.metadata)) {
    changed=true; requireAdditional(registry, principal, projectId, 'project:update:metadata');
  }
  if (!changed) throw new ValidationError('Project update contains no changes');
}

export function registerProjectTools(registry: McpToolRegistry, projects: ProjectStore): void {
  registry.register({
    definition: { name: 'list_projects', description: 'List project registrations visible to the authenticated principal and permitted by project capability.', inputSchema: objectSchema({}) },
    permission: 'project:read',
    handler: async (_args, context) => projects.list().filter((project) =>
      project.permissions.includes('project:read') && (context.principal.projectScopes.includes('*') || context.principal.projectScopes.includes(project.id))),
  });
  registry.register({
    definition: { name: 'get_project', description: 'Get one registered project when both principal and project capability permit reading.', inputSchema: objectSchema({ project_id: projectIdSchema }, ['project_id']) },
    permission: 'project:read', projectArgument: 'project_id',
    handler: async (args) => projects.get(stringArg(args, 'project_id') ?? ''),
  });
  registry.register({
    definition: { name: 'register_project', description: 'Register project metadata only. Requires the full explicit project-registration management permission set and global scope.', inputSchema: objectSchema({ project: createProjectPayload }, ['project']) },
    permission: 'project:register', requiresGlobalScope: true,
    handler: async (args, context) => {
      assertRegistrationPrivileges(registry, context.principal);
      return projects.create(projectInput(args['project']));
    },
  });
  registry.register({
    definition: { name: 'update_project', description: 'Replace mutable registration fields. Each changed field group requires its dedicated management permission; root and capability changes additionally require global scope.', inputSchema: objectSchema({ project_id: projectIdSchema, project: updateProjectPayload }, ['project_id', 'project']) },
    permission: 'project:read', projectArgument: 'project_id', skipProjectCapabilityCheck: true,
    handler: async (args, context) => {
      const projectId=stringArg(args,'project_id')??'';
      const current=projects.get(projectId);
      if(current===null) throw new ValidationError('Project is not available');
      const raw=objectArg(args['project'],'project');
      if(raw['id']!==undefined && raw['id']!==projectId) throw new ValidationError('project.id must match project_id when provided');
      const next=projectInput(args['project'],false);
      assertUpdatePrivileges(registry,context.principal,current,{...next,id:projectId});
      return projects.update(projectId,withoutId(next));
    },
  });
  registry.register({
    definition: { name: 'enable_project', description: 'Re-enable a disabled registry entry. This changes registry state only and never touches project files.', inputSchema: objectSchema({ project_id: projectIdSchema }, ['project_id']) },
    permission: 'project:update:state', projectArgument: 'project_id', skipProjectCapabilityCheck: true,
    handler: async (args) => projects.update(stringArg(args, 'project_id') ?? '', { enabled: true }),
  });
  registry.register({
    definition: { name: 'disable_project', description: 'Disable a registry entry without deleting project files.', inputSchema: objectSchema({ project_id: projectIdSchema }, ['project_id']) },
    permission: 'project:disable', projectArgument: 'project_id', skipProjectCapabilityCheck: true,
    handler: async (args) => projects.disable(stringArg(args, 'project_id') ?? ''),
  });
  registry.register({
    definition: { name: 'remove_project', description: 'Archive the Server Agent registry entry as a tombstone so historical records remain valid. Project files are never deleted.', inputSchema: objectSchema({ project_id: projectIdSchema }, ['project_id']) },
    permission: 'project:archive', projectArgument: 'project_id', skipProjectCapabilityCheck: true,
    handler: async (args) => { projects.remove(stringArg(args, 'project_id') ?? ''); return { ok: true, archived: true }; },
  });
}

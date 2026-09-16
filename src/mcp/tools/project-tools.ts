import type { ProjectStore } from '../../core/interfaces.js';
import type { ProjectRecord } from '../../core/types.js';
import { projectInput, stringArg } from '../arguments.js';
import type { McpToolRegistry } from '../tool-registry.js';
import { objectSchema, projectIdSchema } from './schema-helpers.js';

const projectPayload = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 2, maxLength: 64 },
    name: { type: 'string', minLength: 1, maxLength: 256 },
    root: { type: 'string', minLength: 1, maxLength: 4096 },
    enabled: { type: 'boolean' },
    runtime: { type: 'string', enum: ['node', 'python', 'static', 'other'] },
    serviceName: { type: 'string', maxLength: 256 },
    domain: { type: 'string', maxLength: 512 },
    ports: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 65535 }, maxItems: 64 },
    health: { type: 'object' },
    commands: { type: 'object' },
    database: { type: 'object' },
    deployment: { type: 'object' },
    permissions: { type: 'array', items: { type: 'string' }, maxItems: 64 },
    environmentRefs: { type: 'array', items: { type: 'string' }, maxItems: 128 },
    metadata: { type: 'object' },
  },
  required: ['id','name','root','enabled','runtime','ports','health','commands','database','deployment','permissions','environmentRefs','metadata'],
} as const;

function withoutId(project: Omit<ProjectRecord, 'createdAt' | 'updatedAt'>): Omit<ProjectRecord, 'id' | 'createdAt' | 'updatedAt'> {
  const { id: _id, ...rest } = project;
  return rest;
}

export function registerProjectTools(registry: McpToolRegistry, projects: ProjectStore): void {
  registry.register({
    definition: { name: 'list_projects', description: 'List projects visible to the authenticated principal.', inputSchema: objectSchema({}) },
    permission: 'project:read',
    handler: async (_args, context) => projects.list().filter((project) => context.principal.projectScopes.includes('*') || context.principal.projectScopes.includes(project.id)),
  });
  registry.register({
    definition: { name: 'get_project', description: 'Get one registered project.', inputSchema: objectSchema({ project_id: projectIdSchema }, ['project_id']) },
    permission: 'project:read', projectArgument: 'project_id',
    handler: async (args) => projects.get(stringArg(args, 'project_id') ?? ''),
  });
  registry.register({
    definition: { name: 'register_project', description: 'Register project metadata only. This never creates, deletes, or modifies project files.', inputSchema: objectSchema({ project: projectPayload }, ['project']) },
    permission: 'project:manage', requiresGlobalScope: true,
    handler: async (args) => projects.create(projectInput(args['project'])),
  });
  registry.register({
    definition: { name: 'update_project', description: 'Replace the mutable registration fields for an existing project.', inputSchema: objectSchema({ project_id: projectIdSchema, project: projectPayload }, ['project_id', 'project']) },
    permission: 'project:manage', projectArgument: 'project_id',
    handler: async (args) => projects.update(stringArg(args, 'project_id') ?? '', withoutId(projectInput(args['project'], false))),
  });
  registry.register({
    definition: { name: 'disable_project', description: 'Disable a registry entry without deleting project files.', inputSchema: objectSchema({ project_id: projectIdSchema }, ['project_id']) },
    permission: 'project:manage', projectArgument: 'project_id',
    handler: async (args) => projects.disable(stringArg(args, 'project_id') ?? ''),
  });
  registry.register({
    definition: { name: 'remove_project', description: 'Remove only the Server Agent registry entry. Project files are never deleted.', inputSchema: objectSchema({ project_id: projectIdSchema }, ['project_id']) },
    permission: 'project:manage', projectArgument: 'project_id',
    handler: async (args) => { projects.remove(stringArg(args, 'project_id') ?? ''); return { ok: true }; },
  });
}

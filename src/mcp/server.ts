import type { Server } from 'node:http';
import type { Authorizer } from '../core/interfaces.js';
import type { SqliteDatabase } from '../database/sqlite.js';
import type { McpAuthenticator } from './auth.js';
import { McpToolRegistry } from './tool-registry.js';
import { createMcpNodeServer, McpHttpTransport, type McpTransportOptions, type NodeHealthProvider } from './transport.js';
import { registerServerAgentTools, type ServerAgentMcpServices } from './tools/register-tools.js';
import type { MutationGuard } from '../maintenance/maintenance-service.js';
import { McpTasksExtension } from './tasks-extension.js';
import type { OAuthService } from '../oauth/oauth-service.js';

export interface ServerAgentMcpServerOptions {
  readonly authorizer: Authorizer;
  readonly stateDatabase: SqliteDatabase;
  readonly authenticator: McpAuthenticator;
  readonly services: ServerAgentMcpServices;
  readonly transport: McpTransportOptions;
  readonly mutationGuard?: MutationGuard;
  readonly health?: NodeHealthProvider;
  readonly oauth?: OAuthService;
}

export function createServerAgentMcpServer(options: ServerAgentMcpServerOptions): Server {
  const registry = new McpToolRegistry(
    options.authorizer,
    options.stateDatabase,
    options.services.projects,
    options.mutationGuard,
    options.oauth === undefined ? [] : [options.oauth.config.scope],
  );
  registerServerAgentTools(registry, options.services);
  const tasks = new McpTasksExtension(options.services.operations, options.services.projects, options.authorizer);
  const transport = new McpHttpTransport(options.authenticator, registry, options.transport, tasks);
  return createMcpNodeServer(transport, options.transport.maxBodyBytes, options.health, options.oauth);
}

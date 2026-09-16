import type { Server } from 'node:http';
import type { Authorizer } from '../core/interfaces.js';
import type { SqliteDatabase } from '../database/sqlite.js';
import type { McpAuthenticator } from './auth.js';
import { McpToolRegistry } from './tool-registry.js';
import { createMcpNodeServer, McpHttpTransport, type McpTransportOptions } from './transport.js';
import { registerServerAgentTools, type ServerAgentMcpServices } from './tools/register-tools.js';

export interface ServerAgentMcpServerOptions {
  readonly authorizer: Authorizer;
  readonly stateDatabase: SqliteDatabase;
  readonly authenticator: McpAuthenticator;
  readonly services: ServerAgentMcpServices;
  readonly transport: McpTransportOptions;
}

export function createServerAgentMcpServer(options: ServerAgentMcpServerOptions): Server {
  const registry = new McpToolRegistry(options.authorizer, options.stateDatabase);
  registerServerAgentTools(registry, options.services);
  const transport = new McpHttpTransport(options.authenticator, registry, options.transport);
  return createMcpNodeServer(transport, options.transport.maxBodyBytes);
}

import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Principal } from '../core/types.js';
import { AuthenticationError, AuthorizationError, ProtocolError, ValidationError } from '../core/errors.js';
import type { McpAuthenticator } from './auth.js';
import type { McpToolRegistry } from './tool-registry.js';
import { safeRemoteError, safeRemoteValue } from './remote-response.js';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo';
const PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';

export interface McpHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
  readonly remoteAddress?: string;
}

export interface McpHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface McpTransportOptions {
  readonly path: string;
  readonly maxBodyBytes: number;
  readonly allowedOrigins: readonly string[];
  readonly serverName?: string;
  readonly serverVersion?: string;
}

type JsonRpcId = string | number | null;
type JsonObject = Readonly<Record<string, unknown>>;
interface JsonRpcRequest { readonly jsonrpc: '2.0'; readonly id: JsonRpcId; readonly method: string; readonly params: JsonObject; }

function header(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === target) return value;
  return undefined;
}

function record(value: unknown, name: string): JsonObject {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${name} must be an object`);
  return value as JsonObject;
}

function parseRequest(body: string): JsonRpcRequest {
  let parsed: unknown;
  try { parsed = JSON.parse(body) as unknown; } catch { throw new ProtocolError('Invalid JSON', 'PARSE_ERROR'); }
  const row = record(parsed, 'request');
  if (row['jsonrpc'] !== '2.0') throw new ProtocolError('jsonrpc must be 2.0');
  const id = row['id'];
  if (!(id === null || typeof id === 'string' || typeof id === 'number')) throw new ProtocolError('Request id is invalid');
  if (typeof row['method'] !== 'string' || row['method'] === '') throw new ProtocolError('Request method is invalid');
  return { jsonrpc: '2.0', id, method: row['method'], params: record(row['params'], 'params') };
}

function originAllowed(origin: string, allowlist: readonly string[]): boolean {
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  if (parsed.origin !== origin) return false;
  return allowlist.includes(parsed.origin);
}

function json(status: number, value: unknown): McpHttpResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(value) };
}

export class McpHttpTransport {
  private readonly serverInfo: Readonly<Record<string, string>>;

  public constructor(
    private readonly authenticator: McpAuthenticator,
    private readonly tools: McpToolRegistry,
    private readonly options: McpTransportOptions,
  ) {
    this.serverInfo = { name: options.serverName ?? 'server-agent', version: options.serverVersion ?? '0.5.0' };
  }

  public async handle(request: McpHttpRequest): Promise<McpHttpResponse> {
    if (request.path !== this.options.path) return json(404, { error: 'Not found' });
    if (request.method !== 'POST') return { ...json(405, { error: 'Method not allowed' }), headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', allow: 'POST' } };
    if (Buffer.byteLength(request.body, 'utf8') > this.options.maxBodyBytes) return json(413, { error: 'Request body too large' });
    const contentType = header(request.headers, 'content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) return json(415, { error: 'application/json is required' });
    const origin = header(request.headers, 'origin');
    if (origin !== undefined && !originAllowed(origin, this.options.allowedOrigins)) return json(403, { error: 'Origin is not allowed' });
    if (header(request.headers, 'mcp-session-id') !== undefined) return this.protocolError(null, 400, -32022, 'MCP sessions are not supported by protocol 2026-07-28');

    const authorization = header(request.headers, 'authorization');
    let principal: Principal;
    try {
      principal = await this.authenticator.authenticate({
        ...(authorization === undefined ? {} : { authorization }),
        ...(request.remoteAddress === undefined ? {} : { remoteAddress: request.remoteAddress }),
        ...(origin === undefined ? {} : { origin }),
      });
    } catch (error) {
      const safe = safeRemoteError(error);
      return this.protocolError(null, error instanceof AuthenticationError ? 401 : 403, safe.code, safe.message, safe.data);
    }

    let rpc: JsonRpcRequest;
    try { rpc = parseRequest(request.body); } catch (error) {
      const safe = safeRemoteError(error);
      const code = error instanceof ProtocolError && error.code === 'PARSE_ERROR' ? -32700 : -32600;
      return this.protocolError(null, 400, code, safe.message, safe.data);
    }

    const protocolHeader = header(request.headers, 'mcp-protocol-version');
    if (protocolHeader !== MCP_PROTOCOL_VERSION) return this.protocolError(rpc.id, 400, -32022, 'Unsupported MCP protocol version', { supported: [MCP_PROTOCOL_VERSION] });
    const methodHeader = header(request.headers, 'mcp-method');
    if (methodHeader !== rpc.method) return this.protocolError(rpc.id, 400, -32020, 'Mcp-Method header does not match request body');
    let meta: JsonObject;
    try { meta = record(rpc.params['_meta'], 'params._meta'); } catch (error) { const safe = safeRemoteError(error); return this.protocolError(rpc.id, 400, -32602, safe.message, safe.data); }
    if (meta[PROTOCOL_VERSION_KEY] !== MCP_PROTOCOL_VERSION) return this.protocolError(rpc.id, 400, -32020, 'Request protocol metadata does not match MCP-Protocol-Version');
    try { record(meta[CLIENT_CAPABILITIES_KEY], `params._meta.${CLIENT_CAPABILITIES_KEY}`); }
    catch { return this.protocolError(rpc.id, 400, -32020, 'Client capabilities metadata is required'); }

    if (rpc.method === 'server/discover') return json(200, this.success(rpc.id, {
      resultType: 'complete',
      supportedVersions: [MCP_PROTOCOL_VERSION],
      capabilities: { tools: {} },
      instructions: 'Server Agent exposes project-scoped, authenticated, least-privilege operational tools. Mutating operations remain guarded by project capabilities and safety checks.',
      ttlMs: 300_000,
      cacheScope: 'private',
    }));
    if (rpc.method === 'tools/list') {
      if (header(request.headers, 'mcp-name') !== undefined) return this.protocolError(rpc.id, 400, -32020, 'Mcp-Name is not valid for tools/list');
      return json(200, this.success(rpc.id, { resultType: 'complete', tools: this.tools.list(principal), ttlMs: 0, cacheScope: 'private' }));
    }
    if (rpc.method === 'tools/call') return this.callTool(rpc, request, principal);
    return this.protocolError(rpc.id, 404, -32601, 'Method not found');
  }

  private async callTool(rpc: JsonRpcRequest, request: McpHttpRequest, principal: Principal): Promise<McpHttpResponse> {
    const name = rpc.params['name'];
    if (typeof name !== 'string' || name === '') return this.protocolError(rpc.id, 400, -32602, 'Tool name is required');
    if (header(request.headers, 'mcp-name') !== name) return this.protocolError(rpc.id, 400, -32020, 'Mcp-Name header does not match tool name');
    if (!this.tools.has(name)) return this.protocolError(rpc.id, 404, -32601, 'Tool not found');
    try {
      const value = safeRemoteValue(await this.tools.call(name, rpc.params['arguments'], { principal, requestId: rpc.id }));
      return json(200, this.success(rpc.id, { resultType: 'complete', content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false }));
    } catch (error) {
      const safe = safeRemoteError(error);
      if (error instanceof AuthenticationError || error instanceof AuthorizationError) return this.protocolError(rpc.id, 403, safe.code, safe.message, safe.data);
      const result = { resultType: 'complete', content: [{ type: 'text', text: JSON.stringify({ error: safe.message, errorCode: safe.data['errorCode'] }) }], structuredContent: { error: safe.message, errorCode: safe.data['errorCode'] }, isError: true };
      return json(200, this.success(rpc.id, result));
    }
  }

  private success(id: JsonRpcId, result: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    return { jsonrpc: '2.0', id, result: { ...result, _meta: { [SERVER_INFO_KEY]: this.serverInfo } } };
  }

  private protocolError(id: JsonRpcId, status: number, code: number, message: string, data: Readonly<Record<string, unknown>> = {}): McpHttpResponse {
    return json(status, { jsonrpc: '2.0', id, error: { code, message, data: safeRemoteValue(data) } });
  }
}

async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunkValue of request) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    bytes += chunk.length;
    if (bytes > limit) throw new ValidationError('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function headers(request: IncomingMessage): Readonly<Record<string, string | undefined>> {
  const output: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) output[key] = Array.isArray(value) ? value.join(',') : value;
  return output;
}

function write(response: ServerResponse, result: McpHttpResponse): void {
  response.writeHead(result.status, result.headers);
  response.end(result.body);
}

export function createMcpNodeServer(transport: McpHttpTransport, maxBodyBytes: number): Server {
  return http.createServer(async (request, response) => {
    try {
      const body = await readBody(request, maxBodyBytes);
      const result = await transport.handle({ method: request.method ?? 'GET', path: request.url ?? '/', headers: headers(request), body, ...(request.socket.remoteAddress === undefined ? {} : { remoteAddress: request.socket.remoteAddress }) });
      write(response, result);
    } catch (error) {
      const safe = safeRemoteError(error);
      write(response, json(error instanceof ValidationError ? 413 : 500, { jsonrpc: '2.0', id: null, error: { code: safe.code, message: safe.message, data: safe.data } }));
    }
  });
}

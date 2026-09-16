import path from 'node:path';
import { ValidationError } from '../core/errors.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ServerAgentConfig {
  readonly dataDir: string;
  readonly dbPath: string;
  readonly logLevel: LogLevel;
  readonly maxFileBytes: number;
  readonly maxCommandOutputBytes: number;
  readonly commandTimeoutMs: number;
  readonly maxFixAttempts: number;
  readonly maxConcurrentJobs: number;
  readonly databaseQueryTimeoutMs: number;
  readonly databaseMaxRows: number;
  readonly databaseMaxResultBytes: number;
  readonly maxLogOutputBytes: number;
  readonly maxRecoveryAttempts: number;
  readonly mcpHost: string;
  readonly mcpPort: number;
  readonly mcpPath: string;
  readonly mcpMaxBodyBytes: number;
  readonly mcpAllowedOrigins: readonly string[];
  readonly mcpAllowPublicBind: boolean;
}

const LOG_LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ValidationError(`${name} must be a positive integer`);
  return parsed;
}

function strictBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ValidationError(`${name} must be true or false`);
}

function boundedPort(value: string | undefined, fallback: number): number {
  const port = positiveInt(value, fallback, 'SERVER_AGENT_MCP_PORT');
  if (port > 65535) throw new ValidationError('SERVER_AGENT_MCP_PORT must be a valid TCP port');
  return port;
}

function mcpPath(value: string | undefined): string {
  const candidate = value ?? '/mcp';
  if (!candidate.startsWith('/') || candidate.includes('..') || candidate.includes('?') || candidate.includes('#')) {
    throw new ValidationError('SERVER_AGENT_MCP_PATH must be a simple absolute URL path');
  }
  return candidate;
}

function origins(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === '') return [];
  return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0).map((item) => {
    let parsed: URL;
    try { parsed = new URL(item); } catch { throw new ValidationError('SERVER_AGENT_MCP_ALLOWED_ORIGINS contains an invalid origin'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      throw new ValidationError('SERVER_AGENT_MCP_ALLOWED_ORIGINS entries must be origins only');
    }
    return parsed.origin;
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerAgentConfig {
  const dataDir = path.resolve(env.SERVER_AGENT_DATA_DIR ?? './.runtime');
  const dbPath = path.resolve(env.SERVER_AGENT_DB_PATH ?? path.join(dataDir, 'server-agent.sqlite'));
  const level = (env.SERVER_AGENT_LOG_LEVEL ?? 'info') as LogLevel;
  if (!LOG_LEVELS.has(level)) throw new ValidationError('SERVER_AGENT_LOG_LEVEL is invalid');
  const host = env.SERVER_AGENT_MCP_HOST ?? '127.0.0.1';
  if (host.trim() === '') throw new ValidationError('SERVER_AGENT_MCP_HOST must not be empty');
  const allowPublicBind = strictBoolean(env.SERVER_AGENT_MCP_ALLOW_PUBLIC_BIND, false, 'SERVER_AGENT_MCP_ALLOW_PUBLIC_BIND');
  if (!LOOPBACK_HOSTS.has(host.toLowerCase()) && !allowPublicBind) {
    throw new ValidationError('Non-loopback MCP binding requires SERVER_AGENT_MCP_ALLOW_PUBLIC_BIND=true');
  }

  return {
    dataDir,
    dbPath,
    logLevel: level,
    maxFileBytes: positiveInt(env.SERVER_AGENT_MAX_FILE_BYTES, 1_048_576, 'SERVER_AGENT_MAX_FILE_BYTES'),
    maxCommandOutputBytes: positiveInt(env.SERVER_AGENT_MAX_COMMAND_OUTPUT_BYTES, 262_144, 'SERVER_AGENT_MAX_COMMAND_OUTPUT_BYTES'),
    commandTimeoutMs: positiveInt(env.SERVER_AGENT_COMMAND_TIMEOUT_MS, 120_000, 'SERVER_AGENT_COMMAND_TIMEOUT_MS'),
    maxFixAttempts: positiveInt(env.SERVER_AGENT_MAX_FIX_ATTEMPTS, 3, 'SERVER_AGENT_MAX_FIX_ATTEMPTS'),
    maxConcurrentJobs: positiveInt(env.SERVER_AGENT_MAX_CONCURRENT_JOBS, 1, 'SERVER_AGENT_MAX_CONCURRENT_JOBS'),
    databaseQueryTimeoutMs: positiveInt(env.SERVER_AGENT_DATABASE_QUERY_TIMEOUT_MS, 10_000, 'SERVER_AGENT_DATABASE_QUERY_TIMEOUT_MS'),
    databaseMaxRows: positiveInt(env.SERVER_AGENT_DATABASE_MAX_ROWS, 500, 'SERVER_AGENT_DATABASE_MAX_ROWS'),
    databaseMaxResultBytes: positiveInt(env.SERVER_AGENT_DATABASE_MAX_RESULT_BYTES, 1_048_576, 'SERVER_AGENT_DATABASE_MAX_RESULT_BYTES'),
    maxLogOutputBytes: positiveInt(env.SERVER_AGENT_MAX_LOG_OUTPUT_BYTES, 262_144, 'SERVER_AGENT_MAX_LOG_OUTPUT_BYTES'),
    maxRecoveryAttempts: positiveInt(env.SERVER_AGENT_MAX_RECOVERY_ATTEMPTS, 3, 'SERVER_AGENT_MAX_RECOVERY_ATTEMPTS'),
    mcpHost: host,
    mcpPort: boundedPort(env.SERVER_AGENT_MCP_PORT, 8765),
    mcpPath: mcpPath(env.SERVER_AGENT_MCP_PATH),
    mcpMaxBodyBytes: positiveInt(env.SERVER_AGENT_MCP_MAX_BODY_BYTES, 1_048_576, 'SERVER_AGENT_MCP_MAX_BODY_BYTES'),
    mcpAllowedOrigins: origins(env.SERVER_AGENT_MCP_ALLOWED_ORIGINS),
    mcpAllowPublicBind: allowPublicBind,
  };
}

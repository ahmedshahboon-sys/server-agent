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
  readonly authAttemptsPerMinute: number;
  readonly authRequestsPerMinute: number;
  readonly auditRetentionDays: number;
}

const LOG_LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const LIMITS = {
  maxFileBytes: 16_777_216,
  maxCommandOutputBytes: 4_194_304,
  commandTimeoutMs: 1_800_000,
  maxFixAttempts: 10,
  maxConcurrentJobs: 8,
  databaseQueryTimeoutMs: 120_000,
  databaseMaxRows: 10_000,
  databaseMaxResultBytes: 8_388_608,
  maxLogOutputBytes: 4_194_304,
  maxRecoveryAttempts: 10,
  mcpMaxBodyBytes: 4_194_304,
  authAttemptsPerMinute: 10_000,
  authRequestsPerMinute: 100_000,
  auditRetentionDays: 3650,
} as const;

function boundedPositiveInt(value: string | undefined, fallback: number, name: string, maximum: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new ValidationError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function strictBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ValidationError(`${name} must be true or false`);
}

function boundedPort(value: string | undefined, fallback: number): number {
  return boundedPositiveInt(value, fallback, 'SERVER_AGENT_MCP_PORT', 65535);
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
    maxFileBytes: boundedPositiveInt(env.SERVER_AGENT_MAX_FILE_BYTES, 1_048_576, 'SERVER_AGENT_MAX_FILE_BYTES', LIMITS.maxFileBytes),
    maxCommandOutputBytes: boundedPositiveInt(env.SERVER_AGENT_MAX_COMMAND_OUTPUT_BYTES, 262_144, 'SERVER_AGENT_MAX_COMMAND_OUTPUT_BYTES', LIMITS.maxCommandOutputBytes),
    commandTimeoutMs: boundedPositiveInt(env.SERVER_AGENT_COMMAND_TIMEOUT_MS, 120_000, 'SERVER_AGENT_COMMAND_TIMEOUT_MS', LIMITS.commandTimeoutMs),
    maxFixAttempts: boundedPositiveInt(env.SERVER_AGENT_MAX_FIX_ATTEMPTS, 3, 'SERVER_AGENT_MAX_FIX_ATTEMPTS', LIMITS.maxFixAttempts),
    maxConcurrentJobs: boundedPositiveInt(env.SERVER_AGENT_MAX_CONCURRENT_JOBS, 1, 'SERVER_AGENT_MAX_CONCURRENT_JOBS', LIMITS.maxConcurrentJobs),
    databaseQueryTimeoutMs: boundedPositiveInt(env.SERVER_AGENT_DATABASE_QUERY_TIMEOUT_MS, 10_000, 'SERVER_AGENT_DATABASE_QUERY_TIMEOUT_MS', LIMITS.databaseQueryTimeoutMs),
    databaseMaxRows: boundedPositiveInt(env.SERVER_AGENT_DATABASE_MAX_ROWS, 500, 'SERVER_AGENT_DATABASE_MAX_ROWS', LIMITS.databaseMaxRows),
    databaseMaxResultBytes: boundedPositiveInt(env.SERVER_AGENT_DATABASE_MAX_RESULT_BYTES, 1_048_576, 'SERVER_AGENT_DATABASE_MAX_RESULT_BYTES', LIMITS.databaseMaxResultBytes),
    maxLogOutputBytes: boundedPositiveInt(env.SERVER_AGENT_MAX_LOG_OUTPUT_BYTES, 262_144, 'SERVER_AGENT_MAX_LOG_OUTPUT_BYTES', LIMITS.maxLogOutputBytes),
    maxRecoveryAttempts: boundedPositiveInt(env.SERVER_AGENT_MAX_RECOVERY_ATTEMPTS, 3, 'SERVER_AGENT_MAX_RECOVERY_ATTEMPTS', LIMITS.maxRecoveryAttempts),
    mcpHost: host,
    mcpPort: boundedPort(env.SERVER_AGENT_MCP_PORT, 8765),
    mcpPath: mcpPath(env.SERVER_AGENT_MCP_PATH),
    mcpMaxBodyBytes: boundedPositiveInt(env.SERVER_AGENT_MCP_MAX_BODY_BYTES, 1_048_576, 'SERVER_AGENT_MCP_MAX_BODY_BYTES', LIMITS.mcpMaxBodyBytes),
    mcpAllowedOrigins: origins(env.SERVER_AGENT_MCP_ALLOWED_ORIGINS),
    mcpAllowPublicBind: allowPublicBind,
    authAttemptsPerMinute: boundedPositiveInt(env.SERVER_AGENT_AUTH_ATTEMPTS_PER_MINUTE, 30, 'SERVER_AGENT_AUTH_ATTEMPTS_PER_MINUTE', LIMITS.authAttemptsPerMinute),
    authRequestsPerMinute: boundedPositiveInt(env.SERVER_AGENT_AUTH_REQUESTS_PER_MINUTE, 120, 'SERVER_AGENT_AUTH_REQUESTS_PER_MINUTE', LIMITS.authRequestsPerMinute),
    auditRetentionDays: boundedPositiveInt(env.SERVER_AGENT_AUDIT_RETENTION_DAYS, 30, 'SERVER_AGENT_AUDIT_RETENTION_DAYS', LIMITS.auditRetentionDays),
  };
}

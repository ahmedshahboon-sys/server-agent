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
}

const LOG_LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error']);

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ValidationError(`${name} must be a positive integer`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerAgentConfig {
  const dataDir = path.resolve(env.SERVER_AGENT_DATA_DIR ?? './.runtime');
  const dbPath = path.resolve(env.SERVER_AGENT_DB_PATH ?? path.join(dataDir, 'server-agent.sqlite'));
  const level = (env.SERVER_AGENT_LOG_LEVEL ?? 'info') as LogLevel;
  if (!LOG_LEVELS.has(level)) throw new ValidationError('SERVER_AGENT_LOG_LEVEL is invalid');

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
  };
}

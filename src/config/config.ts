import path from 'node:path';
import { ValidationError } from '../core/errors.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ServerAgentConfig {
  readonly dataDir: string;
  readonly dbPath: string;
  readonly logLevel: LogLevel;
  readonly maxFileBytes: number;
}

const LOG_LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error']);

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ValidationError(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerAgentConfig {
  const dataDir = path.resolve(env.SERVER_AGENT_DATA_DIR ?? './.runtime');
  const dbPath = path.resolve(env.SERVER_AGENT_DB_PATH ?? path.join(dataDir, 'server-agent.sqlite'));
  const level = (env.SERVER_AGENT_LOG_LEVEL ?? 'info') as LogLevel;
  if (!LOG_LEVELS.has(level)) {
    throw new ValidationError('SERVER_AGENT_LOG_LEVEL is invalid');
  }

  return {
    dataDir,
    dbPath,
    logLevel: level,
    maxFileBytes: positiveInt(env.SERVER_AGENT_MAX_FILE_BYTES, 1_048_576, 'SERVER_AGENT_MAX_FILE_BYTES'),
  };
}

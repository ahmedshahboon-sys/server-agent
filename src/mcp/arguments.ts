import type { CommandConfig, DatabaseConfig, DeploymentConfig, HealthConfig, ProjectPermission, ProjectRecord, ProjectRuntime } from '../core/types.js';
import { ValidationError } from '../core/errors.js';

export function objectArg(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${name} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

export function stringArg(args: Readonly<Record<string, unknown>>, name: string, options: { optional?: boolean; max?: number } = {}): string | undefined {
  const value = args[name];
  if (value === undefined && options.optional === true) return undefined;
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${name} must be a non-empty string`);
  if (value.length > (options.max ?? 100_000)) throw new ValidationError(`${name} exceeds the allowed length`);
  return value;
}

export function numberArg(args: Readonly<Record<string, unknown>>, name: string, options: { optional?: boolean; min?: number; max?: number } = {}): number | undefined {
  const value = args[name];
  if (value === undefined && options.optional === true) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ValidationError(`${name} must be a number`);
  if (options.min !== undefined && value < options.min) throw new ValidationError(`${name} is below the allowed minimum`);
  if (options.max !== undefined && value > options.max) throw new ValidationError(`${name} exceeds the allowed maximum`);
  return value;
}

export function booleanArg(args: Readonly<Record<string, unknown>>, name: string, optional = false): boolean | undefined {
  const value = args[name];
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'boolean') throw new ValidationError(`${name} must be a boolean`);
  return value;
}

export function stringArrayArg(args: Readonly<Record<string, unknown>>, name: string, optional = false): readonly string[] | undefined {
  const value = args[name];
  if (value === undefined && optional) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new ValidationError(`${name} must be an array of strings`);
  return value as string[];
}

function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new ValidationError(`${name} must be an array of strings`);
  return value as string[];
}

function numberArray(value: unknown, name: string): readonly number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'number' || !Number.isInteger(item))) throw new ValidationError(`${name} must be an array of integers`);
  return value as number[];
}

function runtime(value: unknown): ProjectRuntime {
  if (!['node', 'python', 'static', 'other'].includes(String(value))) throw new ValidationError('project.runtime is invalid');
  return value as ProjectRuntime;
}

function health(value: unknown): HealthConfig {
  const row = objectArg(value, 'project.health');
  if (!['none', 'http', 'service', 'database', 'composite'].includes(String(row['type']))) throw new ValidationError('project.health.type is invalid');
  return row as unknown as HealthConfig;
}

function optionalArgv(value: unknown, name: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const result = stringArray(value, name);
  if (result.length === 0 || result.length > 64 || result.some((part) => part.length === 0 || part.length > 4096)) throw new ValidationError(`${name} is invalid`);
  return result;
}

function commands(value: unknown): CommandConfig {
  const row = objectArg(value, 'project.commands');
  const allowedValue = row['allowed'];
  let allowed: Readonly<Record<string, readonly string[]>> | undefined;
  if (allowedValue !== undefined) {
    const allowedRow = objectArg(allowedValue, 'project.commands.allowed');
    const entries: Record<string, readonly string[]> = {};
    for (const [name, argv] of Object.entries(allowedRow)) {
      if (!/^[a-z][a-z0-9._-]{0,63}$/.test(name)) throw new ValidationError('project.commands.allowed contains an invalid command id');
      entries[name] = optionalArgv(argv, `project.commands.allowed.${name}`) ?? [];
    }
    allowed = entries;
  }
  const build = optionalArgv(row['build'], 'project.commands.build');
  const test = optionalArgv(row['test'], 'project.commands.test');
  const deploy = optionalArgv(row['deploy'], 'project.commands.deploy');
  const rollback = optionalArgv(row['rollback'], 'project.commands.rollback');
  const validation = row['validation'] === undefined ? undefined : stringArray(row['validation'], 'project.commands.validation');
  return {
    ...(build === undefined ? {} : { build }),
    ...(test === undefined ? {} : { test }),
    ...(deploy === undefined ? {} : { deploy }),
    ...(rollback === undefined ? {} : { rollback }),
    ...(allowed === undefined ? {} : { allowed }),
    ...(validation === undefined ? {} : { validation }),
  };
}

function database(value: unknown): DatabaseConfig {
  const row = objectArg(value, 'project.database');
  if (!['none', 'postgresql', 'mysql', 'sqlite', 'mongodb'].includes(String(row['adapter']))) throw new ValidationError('project.database.adapter is invalid');
  if (!['read', 'controlled-write'].includes(String(row['defaultAccess']))) throw new ValidationError('project.database.defaultAccess is invalid');
  return row as unknown as DatabaseConfig;
}

function deployment(value: unknown): DeploymentConfig {
  const row = objectArg(value, 'project.deployment');
  if (!['none', 'command', 'restart-only'].includes(String(row['strategy']))) throw new ValidationError('project.deployment.strategy is invalid');
  return row as unknown as DeploymentConfig;
}

const PROJECT_PERMISSIONS = new Set<ProjectPermission>([
  'project:read','project:manage','files:read','files:write','git:read','git:write','commands:run','tasks:read','tasks:write',
  'database:read','database:write','deploy:read','deploy:run','health:read','logs:read','service:read','service:restart',
  'recovery:read','recovery:run','rollback:read','rollback:run',
]);
function permissions(value: unknown): readonly ProjectPermission[] {
  const values = stringArray(value, 'project.permissions');
  for (const permission of values) if (!PROJECT_PERMISSIONS.has(permission as ProjectPermission)) throw new ValidationError(`Unknown project permission ${permission}`);
  return [...new Set(values)] as ProjectPermission[];
}

export function projectInput(value: unknown, includeId = true): Omit<ProjectRecord, 'createdAt' | 'updatedAt'> {
  const row = objectArg(value, 'project');
  const idValue = includeId ? row['id'] : row['id'] ?? 'update-placeholder';
  if (typeof idValue !== 'string') throw new ValidationError('project.id must be a string');
  if (typeof row['name'] !== 'string') throw new ValidationError('project.name must be a string');
  if (typeof row['root'] !== 'string') throw new ValidationError('project.root must be a string');
  if (typeof row['enabled'] !== 'boolean') throw new ValidationError('project.enabled must be a boolean');
  const metadata = objectArg(row['metadata'] ?? {}, 'project.metadata');
  const result: Omit<ProjectRecord, 'createdAt' | 'updatedAt'> = {
    id: idValue,
    name: row['name'],
    root: row['root'],
    enabled: row['enabled'],
    runtime: runtime(row['runtime']),
    ...(typeof row['serviceName'] === 'string' ? { serviceName: row['serviceName'] } : {}),
    ...(typeof row['domain'] === 'string' ? { domain: row['domain'] } : {}),
    ports: numberArray(row['ports'], 'project.ports'),
    health: health(row['health']),
    commands: commands(row['commands']),
    database: database(row['database']),
    deployment: deployment(row['deployment']),
    permissions: permissions(row['permissions']),
    environmentRefs: stringArray(row['environmentRefs'], 'project.environmentRefs'),
    metadata,
  };
  return result;
}

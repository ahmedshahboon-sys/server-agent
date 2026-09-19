import type { CommandConfig, DatabaseConfig, DeploymentConfig, HealthConfig, ProjectPermission, ProjectRecord, ProjectRuntime } from '../core/types.js';
import { ValidationError } from '../core/errors.js';

export function objectArg(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${name} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function assertKnownKeys(row: Readonly<Record<string, unknown>>, allowed: readonly string[], name: string): void {
  const known = new Set(allowed);
  for (const key of Object.keys(row)) if (!known.has(key)) throw new ValidationError(`${name} contains unknown field ${key}`);
}

function requiredString(row: Readonly<Record<string, unknown>>, key: string, name: string, max: number): string {
  const value = row[key];
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${name}.${key} must be a non-empty string`);
  if (value.length > max) throw new ValidationError(`${name}.${key} exceeds the allowed length`);
  return value;
}

function optionalString(row: Readonly<Record<string, unknown>>, key: string, name: string, max: number): string | undefined {
  const value = row[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${name}.${key} must be a non-empty string`);
  if (value.length > max) throw new ValidationError(`${name}.${key} exceeds the allowed length`);
  return value;
}

function requiredBoolean(row: Readonly<Record<string, unknown>>, key: string, name: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') throw new ValidationError(`${name}.${key} must be a boolean`);
  return value;
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

function stringArray(value: unknown, name: string, maxItems = 256, maxItemLength = 4096): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== 'string' || item.length === 0 || item.length > maxItemLength)) {
    throw new ValidationError(`${name} must be an array of bounded non-empty strings`);
  }
  return value as string[];
}

function numberArray(value: unknown, name: string, maxItems = 64): readonly number[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== 'number' || !Number.isInteger(item))) {
    throw new ValidationError(`${name} must be an array of bounded integers`);
  }
  return value as number[];
}

function runtime(value: unknown): ProjectRuntime {
  if (!['node', 'python', 'static', 'other'].includes(String(value))) throw new ValidationError('project.runtime is invalid');
  return value as ProjectRuntime;
}

function health(value: unknown): HealthConfig {
  const row = objectArg(value, 'project.health');
  assertKnownKeys(row, ['type','scheme','port','path','timeoutMs','expectedStatus'], 'project.health');
  if (!['none', 'http', 'service', 'database', 'composite'].includes(String(row['type']))) throw new ValidationError('project.health.type is invalid');
  const type = row['type'] as HealthConfig['type'];
  const scheme = row['scheme'];
  if (scheme !== undefined && scheme !== 'http' && scheme !== 'https') throw new ValidationError('project.health.scheme is invalid');
  const port = row['port'];
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port))) throw new ValidationError('project.health.port must be an integer');
  const pathValue = row['path'];
  if (pathValue !== undefined && (typeof pathValue !== 'string' || pathValue.length === 0 || pathValue.length > 2048)) throw new ValidationError('project.health.path is invalid');
  const timeoutMs = row['timeoutMs'];
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000)) throw new ValidationError('project.health.timeoutMs is invalid');
  const expectedStatus = row['expectedStatus'];
  if (expectedStatus !== undefined && (!Array.isArray(expectedStatus) || expectedStatus.length === 0 || expectedStatus.length > 64 || expectedStatus.some((status) => typeof status !== 'number' || !Number.isInteger(status)))) {
    throw new ValidationError('project.health.expectedStatus is invalid');
  }
  return {
    type,
    ...(scheme === undefined ? {} : { scheme }),
    ...(port === undefined ? {} : { port }),
    ...(pathValue === undefined ? {} : { path: pathValue }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(expectedStatus === undefined ? {} : { expectedStatus: expectedStatus as number[] }),
  };
}

function optionalArgv(value: unknown, name: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const result = stringArray(value, name, 64, 4096);
  if (result.length === 0) throw new ValidationError(`${name} is invalid`);
  return result;
}

function commands(value: unknown): CommandConfig {
  const row = objectArg(value, 'project.commands');
  assertKnownKeys(row, ['build','test','deploy','rollback','allowed','validation'], 'project.commands');
  const allowedValue = row['allowed'];
  let allowed: Readonly<Record<string, readonly string[]>> | undefined;
  if (allowedValue !== undefined) {
    const allowedRow = objectArg(allowedValue, 'project.commands.allowed');
    if (Object.keys(allowedRow).length > 128) throw new ValidationError('project.commands.allowed contains too many commands');
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
  const validation = row['validation'] === undefined ? undefined : stringArray(row['validation'], 'project.commands.validation', 64, 64);
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
  assertKnownKeys(row, ['adapter','secretRef','defaultAccess','metadata'], 'project.database');
  if (!['none', 'postgresql', 'mysql', 'sqlite', 'mongodb'].includes(String(row['adapter']))) throw new ValidationError('project.database.adapter is invalid');
  if (!['read', 'controlled-write'].includes(String(row['defaultAccess']))) throw new ValidationError('project.database.defaultAccess is invalid');
  const secretRef = optionalString(row, 'secretRef', 'project.database', 128);
  if (secretRef !== undefined && !/^[A-Z][A-Z0-9_]{1,127}$/.test(secretRef)) throw new ValidationError('project.database.secretRef must be an environment variable name');
  const metadata = row['metadata'] === undefined ? undefined : objectArg(row['metadata'], 'project.database.metadata');
  return {
    adapter: row['adapter'] as DatabaseConfig['adapter'],
    defaultAccess: row['defaultAccess'] as DatabaseConfig['defaultAccess'],
    ...(secretRef === undefined ? {} : { secretRef }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function deployment(value: unknown): DeploymentConfig {
  const row = objectArg(value, 'project.deployment');
  assertKnownKeys(row, ['strategy','branch','requireClean','validationRequired','restartService','healthRequired'], 'project.deployment');
  if (!['none', 'command', 'restart-only'].includes(String(row['strategy']))) throw new ValidationError('project.deployment.strategy is invalid');
  const branch = optionalString(row, 'branch', 'project.deployment', 128);
  return {
    strategy: row['strategy'] as DeploymentConfig['strategy'],
    ...(branch === undefined ? {} : { branch }),
    requireClean: requiredBoolean(row, 'requireClean', 'project.deployment'),
    validationRequired: requiredBoolean(row, 'validationRequired', 'project.deployment'),
    restartService: requiredBoolean(row, 'restartService', 'project.deployment'),
    healthRequired: requiredBoolean(row, 'healthRequired', 'project.deployment'),
  };
}

export const PROJECT_PERMISSIONS = new Set<ProjectPermission>([
  'project:read','project:register','project:update:metadata','project:update:state','project:update:root','project:update:commands',
  'project:update:database','project:update:deployment','project:update:capabilities','project:disable','project:archive',
  'files:read','files:write','git:read','git:write','commands:run','tasks:read','tasks:write',
  'database:read','database:write','deploy:read','deploy:run','health:read','logs:read','service:read','service:restart',
  'recovery:read','recovery:run','rollback:read','rollback:run',
]);

function permissions(value: unknown): readonly ProjectPermission[] {
  const values = stringArray(value, 'project.permissions', 64, 64);
  for (const permission of values) if (!PROJECT_PERMISSIONS.has(permission as ProjectPermission)) throw new ValidationError(`Unknown project permission ${permission}`);
  return [...new Set(values)] as ProjectPermission[];
}

export function projectInput(value: unknown, includeId = true): Omit<ProjectRecord, 'createdAt' | 'updatedAt'> {
  const row = objectArg(value, 'project');
  assertKnownKeys(row, ['id','name','root','enabled','runtime','serviceName','domain','ports','health','commands','database','deployment','permissions','environmentRefs','metadata'], 'project');
  const idValue = includeId ? row['id'] : row['id'] ?? 'update-placeholder';
  if (typeof idValue !== 'string') throw new ValidationError('project.id must be a string');
  const metadata = objectArg(row['metadata'] ?? {}, 'project.metadata');
  const serviceName = optionalString(row, 'serviceName', 'project', 256);
  const domain = optionalString(row, 'domain', 'project', 512);
  return {
    id: idValue,
    name: requiredString(row, 'name', 'project', 256),
    root: requiredString(row, 'root', 'project', 4096),
    enabled: requiredBoolean(row, 'enabled', 'project'),
    runtime: runtime(row['runtime']),
    ...(serviceName === undefined ? {} : { serviceName }),
    ...(domain === undefined ? {} : { domain }),
    ports: numberArray(row['ports'], 'project.ports', 64),
    health: health(row['health']),
    commands: commands(row['commands']),
    database: database(row['database']),
    deployment: deployment(row['deployment']),
    permissions: permissions(row['permissions']),
    environmentRefs: stringArray(row['environmentRefs'], 'project.environmentRefs', 128, 128),
    metadata,
  };
}

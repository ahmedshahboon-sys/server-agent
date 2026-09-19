import path from 'node:path';
import { ValidationError } from '../core/errors.js';
import type { ProjectRecord } from '../core/types.js';
import { PROJECT_CAPABILITY_PERMISSION_SET } from '../security/permissions.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SECRETISH_KEY = /(?:password|secret|token|api[_-]?key|private[_-]?key|credential|database[_-]?url)/i;
const ENV_REF = /^[A-Z][A-Z0-9_]{1,127}$/;
const SERVICE_NAME = /^[A-Za-z0-9_.@:-]{1,256}$/;
const HOSTNAME = /^(?=.{1,253}$)(?!-)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?!-)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function assertNoEmbeddedSecrets(value: unknown, location = 'project'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoEmbeddedSecrets(item, `${location}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (SECRETISH_KEY.test(key)) throw new ValidationError(`Embedded secret-like field is not allowed at ${location}.${key}; use a secret reference`);
    assertNoEmbeddedSecrets(nested, `${location}.${key}`);
  }
}

function assertUnique(values: readonly unknown[], name: string): void {
  if (new Set(values).size !== values.length) throw new ValidationError(`${name} must not contain duplicates`);
}

function assertKnownKeys(value: unknown, allowed: readonly string[], name: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${name} must be an object`);
  const known = new Set(allowed);
  for (const key of Object.keys(value)) if (!known.has(key)) throw new ValidationError(`${name} contains unknown field ${key}`);
}

function assertArgv(argv: readonly string[] | undefined, name: string): void {
  if (argv === undefined) return;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 64) throw new ValidationError(`${name} must contain 1-64 argv entries`);
  for (const part of argv) if (typeof part !== 'string' || part.length === 0 || part.length > 4096 || part.includes('\0')) throw new ValidationError(`${name} contains an invalid argv entry`);
}

export function validateProjectInput(project: Omit<ProjectRecord, 'createdAt' | 'updatedAt'>): void {
  assertKnownKeys(project, ['id','name','root','enabled','runtime','serviceName','domain','ports','health','commands','database','deployment','permissions','environmentRefs','metadata'], 'project');
  assertKnownKeys(project.health, ['type','scheme','port','path','timeoutMs','expectedStatus'], 'project.health');
  assertKnownKeys(project.commands, ['build','test','deploy','rollback','allowed','validation'], 'project.commands');
  assertKnownKeys(project.database, ['adapter','secretRef','defaultAccess','metadata'], 'project.database');
  assertKnownKeys(project.deployment, ['strategy','branch','requireClean','validationRequired','restartService','healthRequired'], 'project.deployment');
  if (!ID_PATTERN.test(project.id)) throw new ValidationError('Project id must be 2-64 lowercase safe characters');
  if (typeof project.name !== 'string' || project.name.trim().length === 0 || project.name.length > 256) throw new ValidationError('Project name is invalid');
  if (typeof project.root !== 'string' || !path.isAbsolute(project.root) || project.root.includes('\0') || project.root.length > 4096) throw new ValidationError('Project root must be a bounded absolute path');
  if (!['node','python','static','other'].includes(project.runtime)) throw new ValidationError('Project runtime is invalid');
  if (project.serviceName !== undefined && !SERVICE_NAME.test(project.serviceName)) throw new ValidationError('Project serviceName is invalid');
  if (project.domain !== undefined && !HOSTNAME.test(project.domain)) throw new ValidationError('Project domain must be a hostname only');

  if (!Array.isArray(project.ports) || project.ports.length > 64 || project.ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new ValidationError('Project ports must be valid TCP/UDP port numbers');
  }
  assertUnique(project.ports, 'Project ports');

  if (!['none','http','service','database','composite'].includes(project.health.type)) throw new ValidationError('Project health type is invalid');
  if (project.health.scheme !== undefined && !['http','https'].includes(project.health.scheme)) throw new ValidationError('Health scheme is invalid');
  if (project.health.timeoutMs !== undefined && (!Number.isInteger(project.health.timeoutMs) || project.health.timeoutMs < 100 || project.health.timeoutMs > 120_000)) throw new ValidationError('Health timeout is invalid');
  if (project.health.path !== undefined && (!project.health.path.startsWith('/') || project.health.path.length > 2048 || project.health.path.includes('\0'))) throw new ValidationError('Health path must be a bounded absolute URL path');
  if (project.health.port !== undefined && !project.ports.includes(project.health.port)) throw new ValidationError('Health port must be one of the registered project ports');
  if (project.health.expectedStatus !== undefined) {
    if (project.health.expectedStatus.length === 0 || project.health.expectedStatus.length > 64 || project.health.expectedStatus.some((status) => !Number.isInteger(status) || status < 100 || status > 599)) throw new ValidationError('Health expectedStatus values must be HTTP status codes');
    assertUnique(project.health.expectedStatus, 'Health expectedStatus');
  }
  if ((project.health.type === 'http' || project.health.type === 'composite') && (project.domain === undefined || project.health.path === undefined)) throw new ValidationError('HTTP health requires project domain and health path');

  assertArgv(project.commands.build, 'commands.build');
  assertArgv(project.commands.test, 'commands.test');
  assertArgv(project.commands.deploy, 'commands.deploy');
  assertArgv(project.commands.rollback, 'commands.rollback');
  const allowedEntries = Object.entries(project.commands.allowed ?? {});
  if (allowedEntries.length > 128) throw new ValidationError('commands.allowed contains too many commands');
  for (const [name, argv] of allowedEntries) {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(name)) throw new ValidationError('commands.allowed contains an invalid command id');
    assertArgv(argv, `commands.allowed.${name}`);
  }

  if (!['none','postgresql','mysql','sqlite','mongodb'].includes(project.database.adapter)) throw new ValidationError('Database adapter is invalid');
  if (!['read','controlled-write'].includes(project.database.defaultAccess)) throw new ValidationError('Database defaultAccess is invalid');
  if (project.database.secretRef !== undefined && !ENV_REF.test(project.database.secretRef)) throw new ValidationError('Database secretRef must be an environment variable name');

  if (!['none','command','restart-only'].includes(project.deployment.strategy)) throw new ValidationError('Deployment strategy is invalid');
  if (project.deployment.branch !== undefined && !/^[A-Za-z0-9._/-]{1,128}$/.test(project.deployment.branch)) throw new ValidationError('Deployment branch contains invalid characters');
  if (project.deployment.strategy === 'command' && project.commands.deploy === undefined) throw new ValidationError('Command deployment strategy requires commands.deploy');
  if ((project.deployment.restartService || project.deployment.strategy === 'restart-only') && project.serviceName === undefined) throw new ValidationError('Deployment restart requires serviceName');
  if (project.deployment.healthRequired && project.health.type === 'none') throw new ValidationError('Health-required deployment must configure a health check');

  if (!Array.isArray(project.permissions) || project.permissions.length > 64) throw new ValidationError('Project permissions are invalid');
  for (const permission of project.permissions) if (!PROJECT_CAPABILITY_PERMISSION_SET.has(permission)) throw new ValidationError(`Unknown project permission ${permission}`);
  assertUnique(project.permissions, 'Project permissions');
  if (project.permissions.includes('recovery:run') && !project.permissions.includes('recovery:read')) throw new ValidationError('recovery:run requires recovery:read for evidence collection');
  if (project.permissions.includes('rollback:run')) {
    if (!project.permissions.includes('git:read')) throw new ValidationError('rollback:run requires git:read');
    if (!project.permissions.includes('commands:run')) throw new ValidationError('rollback:run requires commands:run');
    if (project.deployment.healthRequired && !project.permissions.includes('health:read')) throw new ValidationError('rollback:run requires health:read when rollback health validation is required');
  }

  if (!Array.isArray(project.environmentRefs) || project.environmentRefs.length > 128) throw new ValidationError('Environment references are invalid');
  for (const reference of project.environmentRefs) if (!ENV_REF.test(reference)) throw new ValidationError('Environment references must be variable names, not values');
  assertUnique(project.environmentRefs, 'Environment references');
  if (project.database.secretRef !== undefined && !project.environmentRefs.includes(project.database.secretRef)) throw new ValidationError('Database secretRef must also be listed in environmentRefs');

  if (project.commands.validation !== undefined) {
    if (project.commands.validation.length > 64) throw new ValidationError('Validation pipeline is too long');
    assertUnique(project.commands.validation, 'Validation steps');
    const known = new Set<string>(Object.keys(project.commands.allowed ?? {}));
    if (project.commands.build !== undefined) known.add('build');
    if (project.commands.test !== undefined) known.add('test');
    if (project.commands.deploy !== undefined) known.add('deploy');
    for (const step of project.commands.validation) {
      if (!/^[a-z][a-z0-9._-]{0,63}$/.test(step) || !known.has(step)) throw new ValidationError(`Validation step ${step} is not a configured command`);
      if (step === 'deploy' || step === 'rollback') throw new ValidationError('Validation pipeline cannot execute deploy or rollback commands');
    }
  }

  assertNoEmbeddedSecrets(project.metadata);
  assertNoEmbeddedSecrets(project.database.metadata);
}

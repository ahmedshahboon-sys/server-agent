import path from 'node:path';
import { ValidationError } from '../core/errors.js';
import type { ProjectRecord } from '../core/types.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SECRETISH_KEY = /(?:password|secret|token|api[_-]?key|private[_-]?key|credential|database[_-]?url)/i;

function assertNoEmbeddedSecrets(value: unknown, location = 'project'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoEmbeddedSecrets(item, `${location}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (SECRETISH_KEY.test(key)) {
      throw new ValidationError(`Embedded secret-like field is not allowed at ${location}.${key}; use a secret reference`);
    }
    assertNoEmbeddedSecrets(nested, `${location}.${key}`);
  }
}

export function validateProjectInput(project: Omit<ProjectRecord, 'createdAt' | 'updatedAt'>): void {
  if (!ID_PATTERN.test(project.id)) throw new ValidationError('Project id must be 2-64 lowercase safe characters');
  if (project.name.trim().length === 0) throw new ValidationError('Project name is required');
  if (!path.isAbsolute(project.root)) throw new ValidationError('Project root must be absolute');
  if (project.ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new ValidationError('Project ports must be valid TCP/UDP port numbers');
  }

  if (project.deployment.branch !== undefined && !/^[A-Za-z0-9._/-]{1,128}$/.test(project.deployment.branch)) {
    throw new ValidationError('Deployment branch contains invalid characters');
  }
  if (project.deployment.strategy === 'command' && project.commands.deploy === undefined) {
    throw new ValidationError('Command deployment strategy requires commands.deploy');
  }
  if (project.deployment.restartService && project.serviceName === undefined) {
    throw new ValidationError('Deployment restart requires serviceName');
  }
  if (project.health.path !== undefined && !project.health.path.startsWith('/')) {
    throw new ValidationError('Health path must start with /');
  }
  if (project.health.port !== undefined && !project.ports.includes(project.health.port)) {
    throw new ValidationError('Health port must be one of the registered project ports');
  }
  if (project.health.expectedStatus !== undefined && project.health.expectedStatus.some((status) => !Number.isInteger(status) || status < 100 || status > 599)) {
    throw new ValidationError('Health expectedStatus values must be HTTP status codes');
  }
  if (project.deployment.healthRequired && project.health.type === 'none') {
    throw new ValidationError('Health-required deployment must configure a health check');
  }
  if (project.permissions.includes('recovery:run') && !project.permissions.includes('recovery:read')) {
    throw new ValidationError('recovery:run requires recovery:read for evidence collection');
  }
  if (project.permissions.includes('rollback:run')) {
    if (!project.permissions.includes('git:read')) throw new ValidationError('rollback:run requires git:read');
    if (!project.permissions.includes('commands:run')) throw new ValidationError('rollback:run requires commands:run');
    if (project.deployment.healthRequired && !project.permissions.includes('health:read')) throw new ValidationError('rollback:run requires health:read when rollback health validation is required');
  }
  for (const reference of project.environmentRefs) {
    if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(reference)) throw new ValidationError('Environment references must be variable names, not values');
  }
  if (project.commands.validation !== undefined) {
    const known = new Set<string>(Object.keys(project.commands.allowed ?? {}));
    if (project.commands.build !== undefined) known.add('build');
    if (project.commands.test !== undefined) known.add('test');
    if (project.commands.deploy !== undefined) known.add('deploy');
    for (const step of project.commands.validation) {
      if (!known.has(step)) throw new ValidationError(`Validation step ${step} is not a configured command`);
    }
  }
  assertNoEmbeddedSecrets(project.metadata);
  assertNoEmbeddedSecrets(project.database.metadata);
}

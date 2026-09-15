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
  for (const reference of project.environmentRefs) {
    if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(reference)) throw new ValidationError('Environment references must be variable names, not values');
  }
  assertNoEmbeddedSecrets(project.metadata);
  assertNoEmbeddedSecrets(project.database.metadata);
}

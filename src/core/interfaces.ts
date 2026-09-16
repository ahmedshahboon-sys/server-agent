import type { Principal, ProjectPermission, ProjectRecord } from './types.js';

export interface Clock {
  now(): Date;
}

export interface Logger {
  debug(message: string, context?: Readonly<Record<string, unknown>>): void;
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
  error(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export interface Authorizer {
  assertAllowed(principal: Principal, permission: ProjectPermission, projectId?: string): void;
}

export interface ProjectStore {
  list(): readonly ProjectRecord[];
  get(projectId: string): ProjectRecord | null;
  create(input: Omit<ProjectRecord, 'createdAt' | 'updatedAt'>): ProjectRecord;
  update(projectId: string, patch: Partial<Omit<ProjectRecord, 'id' | 'createdAt' | 'updatedAt'>>): ProjectRecord;
  disable(projectId: string): ProjectRecord;
  remove(projectId: string): void;
}

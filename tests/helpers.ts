import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProjectRecord } from '../src/core/types.js';

export async function tempDir(prefix = 'server-agent-test-'): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { path: directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

export function projectFixture(overrides: Partial<Omit<ProjectRecord, 'createdAt' | 'updatedAt'>> = {}): Omit<ProjectRecord, 'createdAt' | 'updatedAt'> {
  return {
    id: 'project-a',
    name: 'Project A',
    root: '/opt/project-a',
    enabled: true,
    runtime: 'node',
    serviceName: 'project-a.service',
    domain: 'project-a.example.test',
    ports: [3000],
    health: { type: 'http', path: '/health', timeoutMs: 5000 },
    commands: { build: ['npm', 'run', 'build'], test: ['npm', 'test'] },
    database: { adapter: 'postgresql', secretRef: 'PROJECT_A_DB_URL', defaultAccess: 'read', metadata: {} },
    deployment: { strategy: 'none', branch: 'main', requireClean: true, validationRequired: true, restartService: false, healthRequired: true },
    permissions: ['project:read', 'files:read'],
    environmentRefs: ['PROJECT_A_DB_URL'],
    metadata: {},
    ...overrides,
  };
}

import type { Clock, ProjectStore } from '../core/interfaces.js';
import type { ProjectRecord } from '../core/types.js';
import { SystemClock } from '../core/clock.js';
import { ValidationError } from '../core/errors.js';
import type { SqliteDatabase } from '../database/sqlite.js';
import { validateProjectInput } from './validation.js';

type Row = {
  id: string; name: string; root: string; enabled: number; runtime: ProjectRecord['runtime'];
  service_name: string | null; domain: string | null; ports_json: string; health_json: string;
  commands_json: string; database_json: string; deployment_json: string; permissions_json: string; environment_refs_json: string;
  metadata_json: string; created_at: string; updated_at: string;
};

function parseJson<T>(value: string): T { return JSON.parse(value) as T; }

function mapRow(row: Row): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    root: row.root,
    enabled: row.enabled === 1,
    runtime: row.runtime,
    ...(row.service_name === null ? {} : { serviceName: row.service_name }),
    ...(row.domain === null ? {} : { domain: row.domain }),
    ports: parseJson(row.ports_json),
    health: parseJson(row.health_json),
    commands: parseJson(row.commands_json),
    database: parseJson(row.database_json),
    deployment: parseJson(row.deployment_json),
    permissions: parseJson(row.permissions_json),
    environmentRefs: parseJson(row.environment_refs_json),
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectRegistry implements ProjectStore {
  public constructor(private readonly db: SqliteDatabase, private readonly clock: Clock = new SystemClock()) {}

  public list(): readonly ProjectRecord[] {
    return (this.db.raw.prepare('SELECT * FROM projects ORDER BY id').all() as Row[]).map(mapRow);
  }

  public get(projectId: string): ProjectRecord | null {
    const row = this.db.raw.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Row | undefined;
    return row === undefined ? null : mapRow(row);
  }

  public create(input: Omit<ProjectRecord, 'createdAt' | 'updatedAt'>): ProjectRecord {
    validateProjectInput(input);
    if (this.get(input.id) !== null) throw new ValidationError(`Project ${input.id} already exists`);
    const timestamp = this.clock.now().toISOString();
    this.db.raw.prepare(`
      INSERT INTO projects (
        id, name, root, enabled, runtime, service_name, domain, ports_json, health_json,
        commands_json, database_json, deployment_json, permissions_json, environment_refs_json, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.name, input.root, input.enabled ? 1 : 0, input.runtime,
      input.serviceName ?? null, input.domain ?? null, JSON.stringify(input.ports), JSON.stringify(input.health),
      JSON.stringify(input.commands), JSON.stringify(input.database), JSON.stringify(input.deployment), JSON.stringify(input.permissions),
      JSON.stringify(input.environmentRefs), JSON.stringify(input.metadata), timestamp, timestamp,
    );
    return this.getRequired(input.id);
  }

  public update(projectId: string, patch: Partial<Omit<ProjectRecord, 'id' | 'createdAt' | 'updatedAt'>>): ProjectRecord {
    const current = this.getRequired(projectId);
    const candidate = { ...current, ...patch, id: current.id };
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...validated } = candidate;
    validateProjectInput(validated);
    const timestamp = this.clock.now().toISOString();
    this.db.raw.prepare(`
      UPDATE projects SET name=?, root=?, enabled=?, runtime=?, service_name=?, domain=?, ports_json=?, health_json=?,
        commands_json=?, database_json=?, deployment_json=?, permissions_json=?, environment_refs_json=?, metadata_json=?, updated_at=?
      WHERE id=?
    `).run(
      candidate.name, candidate.root, candidate.enabled ? 1 : 0, candidate.runtime,
      candidate.serviceName ?? null, candidate.domain ?? null, JSON.stringify(candidate.ports), JSON.stringify(candidate.health),
      JSON.stringify(candidate.commands), JSON.stringify(candidate.database), JSON.stringify(candidate.deployment), JSON.stringify(candidate.permissions),
      JSON.stringify(candidate.environmentRefs), JSON.stringify(candidate.metadata), timestamp, projectId,
    );
    return this.getRequired(projectId);
  }

  public disable(projectId: string): ProjectRecord {
    return this.update(projectId, { enabled: false });
  }

  private getRequired(projectId: string): ProjectRecord {
    const project = this.get(projectId);
    if (project === null) throw new ValidationError(`Project ${projectId} not found`);
    return project;
  }
}

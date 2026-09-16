import type { DatabaseMigrationStatus } from '../database/adapter.js';
import type { MigrationRollbackSafety } from '../core/types.js';

export interface MigrationRollbackAssessment {
  readonly safety: MigrationRollbackSafety;
  readonly reason: string;
  readonly before: Readonly<Record<string, unknown>>;
  readonly current: Readonly<Record<string, unknown>>;
}

function snapshot(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Readonly<Record<string, unknown>>;
  return {
    known: record['known'] === true,
    system: typeof record['system'] === 'string' ? record['system'] : null,
    current: typeof record['current'] === 'string' ? record['current'] : null,
    pending: typeof record['pending'] === 'number' ? record['pending'] : null,
  };
}

export function assessMigrationRollback(
  adapter: string,
  beforeValue: unknown,
  currentValue: DatabaseMigrationStatus | Readonly<Record<string, unknown>> | null,
): MigrationRollbackAssessment {
  if (adapter === 'none') return { safety: 'SAFE', reason: 'Project has no database adapter', before: {}, current: {} };
  const before = snapshot(beforeValue);
  const current = snapshot(currentValue);
  if (before['known'] !== true || current['known'] !== true) {
    return { safety: 'MANUAL_REQUIRED', reason: 'Migration state is not fully known; automatic database rollback is forbidden', before, current };
  }
  if (before['system'] !== current['system']) {
    return { safety: 'BLOCKED', reason: 'Migration system changed since deployment', before, current };
  }
  if (before['current'] !== current['current']) {
    return { safety: 'MANUAL_REQUIRED', reason: 'Database migration version changed; code rollback cannot assume database rollback', before, current };
  }
  return { safety: 'SAFE', reason: 'Observed migration version matches the pre-deploy state', before, current };
}

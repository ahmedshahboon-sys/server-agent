import type { DatabaseQueryClassification } from '../core/types.js';

export type DatabaseParameter = string | number | bigint | Uint8Array | null;

export interface DatabaseQueryRequest {
  readonly sql: string;
  readonly params?: readonly DatabaseParameter[];
  readonly classification: DatabaseQueryClassification;
  readonly timeoutMs: number;
  readonly maxRows: number;
  readonly maxBytes: number;
}

export interface DatabaseQueryResult {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number;
  readonly changedRows: number;
  readonly truncated: boolean;
}

export interface DatabaseSchemaResult {
  readonly objects: readonly Readonly<Record<string, unknown>>[];
}

export interface DatabaseMigrationStatus {
  readonly known: boolean;
  readonly system: string | null;
  readonly current: string | null;
  readonly pending: number | null;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface DatabaseStatusResult {
  readonly connected: boolean;
  readonly latencyMs: number;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface DatabaseAdapter {
  status(timeoutMs: number): Promise<DatabaseStatusResult>;
  schema(timeoutMs: number, maxRows: number): Promise<DatabaseSchemaResult>;
  query(request: DatabaseQueryRequest): Promise<DatabaseQueryResult>;
  transaction(requests: readonly DatabaseQueryRequest[]): Promise<readonly DatabaseQueryResult[]>;
  migrationStatus(timeoutMs: number): Promise<DatabaseMigrationStatus>;
  close(): Promise<void>;
}

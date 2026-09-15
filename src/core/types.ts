export type ProjectRuntime = 'node' | 'python' | 'static' | 'other';

export type ProjectPermission =
  | 'project:read'
  | 'project:manage'
  | 'files:read'
  | 'files:write'
  | 'git:read'
  | 'git:write'
  | 'commands:run'
  | 'database:read'
  | 'database:write'
  | 'deploy:run'
  | 'health:read';

export interface CommandConfig {
  readonly build?: readonly string[];
  readonly test?: readonly string[];
  readonly deploy?: readonly string[];
  readonly allowed?: Readonly<Record<string, readonly string[]>>;
}

export interface DatabaseConfig {
  readonly adapter: 'none' | 'postgresql' | 'mysql' | 'sqlite' | 'mongodb';
  readonly secretRef?: string;
  readonly defaultAccess: 'read' | 'controlled-write';
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HealthConfig {
  readonly type: 'none' | 'http' | 'service' | 'composite';
  readonly path?: string;
  readonly timeoutMs?: number;
}

export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly enabled: boolean;
  readonly runtime: ProjectRuntime;
  readonly serviceName?: string;
  readonly domain?: string;
  readonly ports: readonly number[];
  readonly health: HealthConfig;
  readonly commands: CommandConfig;
  readonly database: DatabaseConfig;
  readonly permissions: readonly ProjectPermission[];
  readonly environmentRefs: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Principal {
  readonly id: string;
  readonly kind: 'system' | 'remote' | 'local';
  readonly projectScopes: readonly string[];
  readonly permissions: readonly ProjectPermission[];
}

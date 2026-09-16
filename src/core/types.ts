export type ProjectRuntime = 'node' | 'python' | 'static' | 'other';

export type ProjectPermission =
  | 'project:read'
  | 'project:manage'
  | 'files:read'
  | 'files:write'
  | 'git:read'
  | 'git:write'
  | 'commands:run'
  | 'tasks:read'
  | 'tasks:write'
  | 'database:read'
  | 'database:write'
  | 'deploy:read'
  | 'deploy:run'
  | 'health:read'
  | 'logs:read'
  | 'service:read'
  | 'service:restart'
  | 'recovery:read'
  | 'recovery:run'
  | 'rollback:read'
  | 'rollback:run';

export interface CommandConfig {
  readonly build?: readonly string[];
  readonly test?: readonly string[];
  readonly deploy?: readonly string[];
  readonly rollback?: readonly string[];
  readonly allowed?: Readonly<Record<string, readonly string[]>>;
  readonly validation?: readonly string[];
}

export interface DatabaseConfig {
  readonly adapter: 'none' | 'postgresql' | 'mysql' | 'sqlite' | 'mongodb';
  readonly secretRef?: string;
  readonly defaultAccess: 'read' | 'controlled-write';
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HealthConfig {
  readonly type: 'none' | 'http' | 'service' | 'database' | 'composite';
  readonly scheme?: 'http' | 'https';
  readonly port?: number;
  readonly path?: string;
  readonly timeoutMs?: number;
  readonly expectedStatus?: readonly number[];
}

export interface DeploymentConfig {
  readonly strategy: 'none' | 'command' | 'restart-only';
  readonly branch?: string;
  readonly requireClean: boolean;
  readonly validationRequired: boolean;
  readonly restartService: boolean;
  readonly healthRequired: boolean;
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
  readonly deployment: DeploymentConfig;
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

export type TaskStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'PAUSED'
  | 'FAILED'
  | 'WAITING_FOR_USER'
  | 'RECOVERY_REQUIRED'
  | 'DEPLOYING'
  | 'HEALTH_CHECKING'
  | 'RECOVERING'
  | 'ROLLBACK_REQUIRED'
  | 'ROLLING_BACK'
  | 'COMPLETED'
  | 'ROLLED_BACK'
  | 'CANCELLED';

export type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';

export type DatabaseQueryClassification = 'READ' | 'WRITE' | 'DESTRUCTIVE' | 'TRANSACTION_CONTROL' | 'UNKNOWN';
export type HealthState = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
export type DeploymentStatus = 'PREPARING' | 'DEPLOYING' | 'HEALTH_CHECKING' | 'SUCCEEDED' | 'FAILED';
export type RecoveryStatus = 'ASSESSING' | 'RESUME_RECOMMENDED' | 'ROLLBACK_REQUIRED' | 'MANUAL_REQUIRED' | 'FAILED';
export type RollbackStatus = 'PLANNED' | 'BLOCKED' | 'READY' | 'ROLLING_BACK' | 'HEALTH_CHECKING' | 'SUCCEEDED' | 'FAILED';
export type MigrationRollbackSafety = 'SAFE' | 'MANUAL_REQUIRED' | 'BLOCKED';

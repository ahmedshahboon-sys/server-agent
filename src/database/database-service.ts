import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Authorizer, ProjectStore } from '../core/interfaces.js';
import type { DatabaseQueryClassification, Principal, ProjectRecord } from '../core/types.js';
import { AuthorizationError, ValidationError } from '../core/errors.js';
import { redactError } from '../security/redaction.js';
import { ProjectPathSandbox } from '../security/sandbox.js';
import { currentIdempotencyKey } from '../idempotency/context.js';
import { IdempotencyStore, idempotencyFingerprint } from '../idempotency/idempotency.js';
import { OperationLeaseStore } from '../operations/operation-lease.js';
import type { SqliteDatabase } from './sqlite.js';
import type { DatabaseAdapter, DatabaseParameter, DatabaseQueryRequest, DatabaseQueryResult, DatabaseSchemaResult, DatabaseMigrationStatus, DatabaseStatusResult } from './adapter.js';
import { SqliteProjectAdapter } from './sqlite-adapter.js';
import { assertNonDestructiveSql } from './sql-safety.js';

export interface DatabaseServiceOptions {
  readonly timeoutMs: number;
  readonly maxRows: number;
  readonly maxResultBytes: number;
}

export interface DatabaseMutationSafety {
  readonly idempotency?: IdempotencyStore;
  readonly leases?: OperationLeaseStore;
  readonly ownerId?: string;
  readonly leaseTtlMs?: number;
}

export interface DatabaseAdapterFactory {
  create(project: ProjectRecord): Promise<DatabaseAdapter>;
}

export class ProjectDatabaseAdapterFactory implements DatabaseAdapterFactory {
  public async create(project: ProjectRecord): Promise<DatabaseAdapter> {
    if (project.database.adapter === 'none') throw new ValidationError('Project has no database configured');
    if (project.database.adapter !== 'sqlite') throw new ValidationError(`Database adapter ${project.database.adapter} is not implemented in this build`);
    const relative = project.database.metadata?.['path'];
    if (typeof relative !== 'string' || relative.trim() === '') throw new ValidationError('SQLite database metadata.path is required');
    if (path.isAbsolute(relative)) throw new ValidationError('SQLite database path must be project-relative');
    if (!['.sqlite', '.sqlite3', '.db'].includes(path.extname(relative).toLowerCase())) throw new ValidationError('SQLite database path must use .sqlite, .sqlite3, or .db');
    const sandbox = await ProjectPathSandbox.create(project.root);
    const filename = await sandbox.resolveForRead(relative, { allowSensitive: true });
    return new SqliteProjectAdapter(filename);
  }
}

export class DatabaseService {
  private readonly mutationOwner:string;
  public constructor(
    private readonly stateDb: SqliteDatabase,
    private readonly projects: ProjectStore,
    private readonly authorizer: Authorizer,
    private readonly factory: DatabaseAdapterFactory,
    private readonly options: DatabaseServiceOptions,
    private readonly mutationSafety: DatabaseMutationSafety = {},
  ) { this.mutationOwner=mutationSafety.ownerId??randomUUID(); }

  public async status(projectId: string, principal: Principal): Promise<DatabaseStatusResult> {
    const project = this.requireCapability(projectId, principal, 'READ');
    return this.withAdapter(project, (adapter) => adapter.status(this.options.timeoutMs));
  }

  public async schema(projectId: string, principal: Principal): Promise<DatabaseSchemaResult> {
    const project = this.requireCapability(projectId, principal, 'READ');
    return this.withAdapter(project, (adapter) => adapter.schema(this.options.timeoutMs, this.options.maxRows));
  }

  public async migrationStatus(projectId: string, principal: Principal): Promise<DatabaseMigrationStatus> {
    const project = this.requireCapability(projectId, principal, 'READ');
    return this.withAdapter(project, (adapter) => adapter.migrationStatus(this.options.timeoutMs));
  }

  public async query(projectId: string, principal: Principal, sql: string, params: readonly DatabaseParameter[] = [], idempotencyKey?: string): Promise<DatabaseQueryResult & { classification: DatabaseQueryClassification }> {
    const classification = assertNonDestructiveSql(sql).classification;
    const project = this.requireCapability(projectId, principal, classification);
    const request = this.request(sql, params, classification);
    const execute = async ():Promise<DatabaseQueryResult & { classification: DatabaseQueryClassification }> => {
      try {
        const result = await this.withAdapter(project, (adapter) => adapter.query(request));
        this.audit(projectId, 'query', classification, sql, result.rowCount + result.changedRows, true);
        return { ...result, classification };
      } catch (error) {
        this.audit(projectId, 'query', classification, sql, null, false, error);
        throw error;
      }
    };
    if(classification!=='WRITE')return execute();
    return this.guardedWrite(projectId,'query',idempotencyKey,idempotencyFingerprint({sql,params}),execute);
  }

  public async transaction(projectId: string, principal: Principal, statements: readonly { sql: string; params?: readonly DatabaseParameter[] }[], idempotencyKey?: string): Promise<readonly DatabaseQueryResult[]> {
    if (statements.length === 0 || statements.length > 50) throw new ValidationError('Transaction must contain 1-50 statements');
    const classified = statements.map((statement) => ({ statement, classification: assertNonDestructiveSql(statement.sql).classification }));
    const strongest: DatabaseQueryClassification = classified.some((item) => item.classification === 'WRITE') ? 'WRITE' : 'READ';
    const project = this.requireCapability(projectId, principal, strongest);
    const requests = classified.map(({ statement, classification }) => this.request(statement.sql, statement.params ?? [], classification));
    const execute = async ():Promise<readonly DatabaseQueryResult[]> => {
      try {
        const results = await this.withAdapter(project, (adapter) => adapter.transaction(requests));
        for (let index = 0; index < classified.length; index += 1) {
          const item = classified[index]; const result = results[index];
          if (item !== undefined) this.audit(projectId, 'transaction', item.classification, item.statement.sql, result === undefined ? null : result.rowCount + result.changedRows, true);
        }
        return results;
      } catch (error) {
        for (const item of classified) this.audit(projectId, 'transaction', item.classification, item.statement.sql, null, false, error);
        throw error;
      }
    };
    if(strongest!=='WRITE')return execute();
    return this.guardedWrite(projectId,'transaction',idempotencyKey,idempotencyFingerprint(statements),execute);
  }

  private async guardedWrite<T>(projectId:string,operation:string,key:string|undefined,fingerprint:string,run:()=>Promise<T>):Promise<T>{
    const store=this.mutationSafety.idempotency;
    if(store===undefined)return run();
    const effectiveKey=key??currentIdempotencyKey();
    if(effectiveKey===undefined||effectiveKey.trim()==='')throw new ValidationError('idempotency_key is required for database writes');
    const scope=`database-write:${projectId}:${operation}`;
    const replay=store.requireReplayable(scope,effectiveKey,fingerprint);
    if(replay!==null)return replay.result as T;
    store.begin(scope,effectiveKey,fingerprint);
    const owner=`${this.mutationOwner}:${operation}:${effectiveKey}`;
    let lease=false;
    try{
      if(this.mutationSafety.leases!==undefined){this.mutationSafety.leases.acquire(projectId,`database:${operation}`,owner,this.mutationSafety.leaseTtlMs??Math.max(10_000,this.options.timeoutMs+5_000));lease=true;}
      const result=await run();store.complete(scope,effectiveKey,result);return result;
    }catch(error){const current=store.get(scope,effectiveKey);if(current?.status==='IN_PROGRESS')store.fail(scope,effectiveKey,redactError(error));throw error;}
    finally{if(lease)this.mutationSafety.leases?.release(projectId,owner);}
  }

  private requireCapability(projectId: string, principal: Principal, classification: DatabaseQueryClassification): ProjectRecord {
    const write = classification === 'WRITE';
    this.authorizer.assertAllowed(principal, write ? 'database:write' : 'database:read', projectId);
    const project = this.projects.get(projectId);
    if (project === null || !project.enabled) throw new ValidationError('Project is not available');
    const permission = write ? 'database:write' : 'database:read';
    if (!project.permissions.includes(permission)) throw new AuthorizationError(`Project does not permit ${permission}`);
    if (write && project.database.defaultAccess !== 'controlled-write') throw new AuthorizationError('Project database is configured read-only');
    return project;
  }

  private request(sql: string, params: readonly DatabaseParameter[], classification: DatabaseQueryClassification): DatabaseQueryRequest {
    return { sql, params, classification, timeoutMs: this.options.timeoutMs, maxRows: this.options.maxRows, maxBytes: this.options.maxResultBytes };
  }

  private async withAdapter<T>(project: ProjectRecord, run: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    const adapter = await this.factory.create(project);
    try { return await run(adapter); } finally { await adapter.close(); }
  }

  private audit(projectId: string, operation: string, classification: DatabaseQueryClassification, sql: string, rowCount: number | null, success: boolean, error?: unknown): void {
    const statementHash = createHash('sha256').update(sql).digest('hex');
    this.stateDb.raw.prepare('INSERT INTO database_audit(audit_id,project_id,operation,classification,statement_hash,row_count,success,error_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), projectId, operation, classification, statementHash, rowCount, success ? 1 : 0, error === undefined ? null : JSON.stringify(redactError(error)), new Date().toISOString());
  }
}

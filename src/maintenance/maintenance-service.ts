import { existsSync, statfsSync, statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SqliteDatabase } from '../database/sqlite.js';
import { ConflictError, ValidationError } from '../core/errors.js';

export interface MaintenanceOptions {
  readonly dataDir: string;
  readonly dbPath: string;
  readonly maintenanceMode: boolean;
  readonly operationalRetentionDays: number;
  readonly jobLogRetentionDays: number;
  readonly minFreeDiskBytes: number;
  readonly stateDbWarningBytes: number;
}

export interface MutationGuard {
  assertMutationAllowed(targetPath?: string, requiredBytes?: number): void;
}

export interface MaintenanceReport {
  readonly databaseAuditDeleted: number;
  readonly healthChecksDeleted: number;
  readonly validationRunsDeleted: number;
  readonly recoveryRunsDeleted: number;
  readonly idempotencyKeysDeleted: number;
  readonly jobLogFilesDeleted: number;
  readonly walCheckpoint: Readonly<Record<string, unknown>>;
}

export interface RuntimeMetrics {
  readonly maintenanceMode: boolean;
  readonly dataDir: string;
  readonly dbBytes: number;
  readonly walBytes: number;
  readonly freeDiskBytes: number;
  readonly minFreeDiskBytes: number;
  readonly stateDbWarningBytes: number;
  readonly stateDbWarning: boolean;
  readonly jobs: Readonly<Record<string, number>>;
  readonly operations: Readonly<Record<string, number>>;
  readonly errors24h: Readonly<Record<string, number>>;
}

const TERMINAL_TASKS = "('COMPLETED','ROLLED_BACK','CANCELLED')";
const TERMINAL_JOBS = "('COMPLETED','FAILED','CANCELLED')";

function cutoff(days:number,now:Date):string{return new Date(now.getTime()-days*86_400_000).toISOString();}
function countRows(rows:readonly {status:string;n:number}[]):Record<string,number>{const output:Record<string,number>={};for(const row of rows)output[row.status]=Number(row.n);return output;}
function safeStatSize(filename:string):number{try{return statSync(filename).size;}catch{return 0;}}

function nearestExisting(candidate:string):string{
  let current=path.resolve(candidate);
  while(!existsSync(current)){
    const parent=path.dirname(current);
    if(parent===current) return current;
    current=parent;
  }
  return current;
}

export class MaintenanceService implements MutationGuard {
  public constructor(private readonly db:SqliteDatabase,private readonly options:MaintenanceOptions){
    for(const [name,value] of Object.entries({
      operationalRetentionDays:options.operationalRetentionDays,
      jobLogRetentionDays:options.jobLogRetentionDays,
      minFreeDiskBytes:options.minFreeDiskBytes,
      stateDbWarningBytes:options.stateDbWarningBytes,
    })) if(!Number.isSafeInteger(value)||value<1)throw new ValidationError(`${name} must be a positive integer`);
  }

  public isMaintenanceMode():boolean{return this.options.maintenanceMode;}

  public assertMutationAllowed(targetPath=this.options.dataDir,requiredBytes=0):void{
    if(this.options.maintenanceMode)throw new ConflictError('Server Agent is in maintenance mode; mutating operations are disabled');
    if(!Number.isSafeInteger(requiredBytes)||requiredBytes<0)throw new ValidationError('Required disk bytes must be a non-negative integer');
    const free=this.freeBytes(targetPath);
    if(free<this.options.minFreeDiskBytes+requiredBytes){
      throw new ConflictError('Insufficient free disk space for mutating operation');
    }
  }

  public readiness():Readonly<Record<string,unknown>>{
    let freeDiskBytes=0;
    let diskReady=false;
    try{freeDiskBytes=this.freeBytes(this.options.dataDir);diskReady=freeDiskBytes>=this.options.minFreeDiskBytes;}catch{}
    const dbReady=this.db.raw.prepare('SELECT 1 AS ok').get()!==undefined;
    return {
      ready:dbReady&&diskReady,
      database:dbReady?'ready':'unavailable',
      disk:diskReady?'ready':'low',
      freeDiskBytes,
      minFreeDiskBytes:this.options.minFreeDiskBytes,
      maintenanceMode:this.options.maintenanceMode,
    };
  }

  public liveness():Readonly<Record<string,unknown>>{
    return {live:true,uptimeSeconds:Math.round(process.uptime()),maintenanceMode:this.options.maintenanceMode};
  }

  public metrics(now=new Date()):RuntimeMetrics{
    const jobs=this.db.raw.prepare('SELECT status,COUNT(*) AS n FROM jobs GROUP BY status').all() as unknown as Array<{status:string;n:number}>;
    const operations=this.db.raw.prepare('SELECT status,COUNT(*) AS n FROM persistent_operations GROUP BY status').all() as unknown as Array<{status:string;n:number}>;
    const since=new Date(now.getTime()-86_400_000).toISOString();
    const mcpErrors=this.db.raw.prepare('SELECT COUNT(*) AS n FROM mcp_audit WHERE success=0 AND created_at>=?').get(since) as unknown as {n:number};
    const authErrors=this.db.raw.prepare("SELECT COUNT(*) AS n FROM auth_audit WHERE outcome IN ('FAILURE','RATE_LIMITED') AND created_at>=?").get(since) as unknown as {n:number};
    const dbBytes=safeStatSize(this.options.dbPath);
    const walBytes=safeStatSize(`${this.options.dbPath}-wal`);
    return {
      maintenanceMode:this.options.maintenanceMode,
      dataDir:this.options.dataDir,
      dbBytes,
      walBytes,
      freeDiskBytes:this.freeBytes(this.options.dataDir),
      minFreeDiskBytes:this.options.minFreeDiskBytes,
      stateDbWarningBytes:this.options.stateDbWarningBytes,
      stateDbWarning:dbBytes+walBytes>=this.options.stateDbWarningBytes,
      jobs:countRows(jobs),
      operations:countRows(operations),
      errors24h:{mcp:Number(mcpErrors.n),auth:Number(authErrors.n)},
    };
  }

  public async runStartupMaintenance(now=new Date()):Promise<MaintenanceReport>{
    const operationalCutoff=cutoff(this.options.operationalRetentionDays,now);
    const logCutoff=cutoff(this.options.jobLogRetentionDays,now);

    const databaseAudit=this.db.raw.prepare('DELETE FROM database_audit WHERE created_at < ?').run(operationalCutoff);
    const healthChecks=this.db.raw.prepare('DELETE FROM health_checks WHERE checked_at < ?').run(operationalCutoff);
    const validationRuns=this.db.raw.prepare(`DELETE FROM validation_runs WHERE finished_at < ? AND task_id IN (SELECT task_id FROM tasks WHERE status IN ${TERMINAL_TASKS})`).run(operationalCutoff);
    const recoveryRuns=this.db.raw.prepare(`DELETE FROM recovery_runs
      WHERE finished_at IS NOT NULL AND finished_at < ?
        AND task_id IN (SELECT task_id FROM tasks WHERE status IN ${TERMINAL_TASKS})
        AND attempt < (SELECT MAX(r2.attempt) FROM recovery_runs r2 WHERE r2.task_id=recovery_runs.task_id)`).run(operationalCutoff);
    const idempotency=this.db.raw.prepare("DELETE FROM idempotency_keys WHERE status!='IN_PROGRESS' AND updated_at < ?").run(operationalCutoff);

    let jobLogFilesDeleted=0;
    const rows=this.db.raw.prepare(`SELECT stdout_path,stderr_path FROM jobs WHERE status IN ${TERMINAL_JOBS} AND finished_at IS NOT NULL AND finished_at < ?`).all(logCutoff) as unknown as Array<{stdout_path:string;stderr_path:string}>;
    const jobsRoot=path.resolve(this.options.dataDir,'jobs');
    for(const row of rows){
      for(const filename of [row.stdout_path,row.stderr_path]){
        const resolved=path.resolve(filename);
        if(resolved!==jobsRoot&&!resolved.startsWith(`${jobsRoot}${path.sep}`))continue;
        try{await fs.unlink(resolved);jobLogFilesDeleted+=1;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      }
    }

    const checkpoint=(this.db.raw.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() ?? {}) as Readonly<Record<string,unknown>>;
    return {
      databaseAuditDeleted:Number(databaseAudit.changes),
      healthChecksDeleted:Number(healthChecks.changes),
      validationRunsDeleted:Number(validationRuns.changes),
      recoveryRunsDeleted:Number(recoveryRuns.changes),
      idempotencyKeysDeleted:Number(idempotency.changes),
      jobLogFilesDeleted,
      walCheckpoint:checkpoint,
    };
  }

  private freeBytes(targetPath:string):number{
    const stat=statfsSync(nearestExisting(targetPath));
    const value=Number(stat.bavail)*Number(stat.bsize);
    if(!Number.isSafeInteger(value)||value<0)throw new ValidationError('Filesystem free-space value is invalid');
    return value;
  }
}

import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../database/sqlite.js';
import { ConflictError, ValidationError } from '../core/errors.js';
import { currentIdempotencyKey } from '../idempotency/context.js';
import { IdempotencyStore, idempotencyFingerprint } from '../idempotency/idempotency.js';
import { OperationLeaseStore } from './operation-lease.js';
import { redactError, redactValue } from '../security/redaction.js';
import type { MutationGuard } from '../maintenance/maintenance-service.js';

export type PersistentOperationType = 'VALIDATION' | 'DEPLOYMENT' | 'ROLLBACK';
export type PersistentOperationStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

export interface PersistentOperationRecord {
  readonly operationId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly type: PersistentOperationType;
  readonly status: PersistentOperationStatus;
  readonly targetId: string | null;
  readonly createdAt: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly result: unknown;
  readonly error: unknown;
}

export interface PersistentOperationResult {
  readonly targetId?: string;
  readonly result: unknown;
  readonly succeeded?: boolean;
  readonly error?: unknown;
}

type Row = {
  operation_id:string;task_id:string;project_id:string;operation_type:PersistentOperationType;status:PersistentOperationStatus;
  target_id:string|null;created_at:string;started_at:string;finished_at:string|null;result_json:string|null;error_json:string|null;
};

function parse(value:string|null):unknown{return value===null?null:JSON.parse(value) as unknown;}
function map(row:Row):PersistentOperationRecord{return{
  operationId:row.operation_id,taskId:row.task_id,projectId:row.project_id,type:row.operation_type,status:row.status,targetId:row.target_id,
  createdAt:row.created_at,startedAt:row.started_at,finishedAt:row.finished_at,result:parse(row.result_json),error:parse(row.error_json),
};}

export class PersistentOperationManager {
  private readonly active=new Map<string,Promise<void>>();
  private shuttingDown=false;

  public constructor(
    private readonly db:SqliteDatabase,
    private readonly idempotency:IdempotencyStore,
    private readonly leases:OperationLeaseStore,
    private readonly instanceId:string,
    private readonly leaseTtlMs=60_000,
    private readonly mutationGuard?:MutationGuard,
  ) {
    if(!Number.isInteger(leaseTtlMs)||leaseTtlMs<5_000||leaseTtlMs>86_400_000)throw new ValidationError('Persistent operation lease TTL must be between 5 seconds and 24 hours');
  }

  public get(operationId:string):PersistentOperationRecord|null{
    const row=this.db.raw.prepare('SELECT * FROM persistent_operations WHERE operation_id=?').get(operationId) as Row|undefined;
    return row===undefined?null:map(row);
  }

  public list(projectId:string,taskId?:string):readonly PersistentOperationRecord[]{
    const rows=(taskId===undefined
      ? this.db.raw.prepare('SELECT * FROM persistent_operations WHERE project_id=? ORDER BY created_at DESC LIMIT 100').all(projectId)
      : this.db.raw.prepare('SELECT * FROM persistent_operations WHERE project_id=? AND task_id=? ORDER BY created_at DESC LIMIT 100').all(projectId,taskId)) as Row[];
    return rows.map(map);
  }

  public start(
    type:PersistentOperationType,
    projectId:string,
    taskId:string,
    run:()=>Promise<PersistentOperationResult>,
    idempotencyKey?:string,
  ):PersistentOperationRecord{
    if(this.shuttingDown)throw new ConflictError('Agent is shutting down and cannot start a persistent operation');
    this.mutationGuard?.assertMutationAllowed(undefined,1_048_576);
    if(projectId.trim()===''||taskId.trim()==='')throw new ValidationError('Persistent operation project and task ids are required');
    const effectiveKey=idempotencyKey??currentIdempotencyKey();
    if(effectiveKey===undefined||effectiveKey.trim()==='')throw new ValidationError('idempotency_key is required for persistent operations');
    const scope=`persistent-operation:${type}:${projectId}`;
    const fingerprint=idempotencyFingerprint({type,projectId,taskId});
    const replay=this.idempotency.requireReplayable(scope,effectiveKey,fingerprint);
    if(replay!==null){
      const operationId=(replay.result as {operationId?:unknown}|null)?.operationId;
      if(typeof operationId!=='string')throw new ConflictError('Stored persistent operation result is invalid');
      return this.getRequired(operationId);
    }

    this.idempotency.begin(scope,effectiveKey,fingerprint);
    const operationId=randomUUID();
    const ownerId=`${this.instanceId}:${operationId}`;
    let leaseHeld=false;
    try{
      this.leases.acquire(projectId,`persistent-${type.toLowerCase()}`,ownerId,this.leaseTtlMs);
      leaseHeld=true;
      const now=new Date().toISOString();
      this.db.raw.prepare('INSERT INTO persistent_operations(operation_id,task_id,project_id,operation_type,status,target_id,created_at,started_at,finished_at,result_json,error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(operationId,taskId,projectId,type,'RUNNING',null,now,now,null,null,null);
      this.idempotency.complete(scope,effectiveKey,{operationId});
      const execution=this.execute(operationId,projectId,ownerId,run);
      this.active.set(operationId,execution);
      void execution;
      return this.getRequired(operationId);
    }catch(error){
      if(leaseHeld)this.leases.release(projectId,ownerId);
      const record=this.idempotency.get(scope,effectiveKey);
      if(record?.status==='IN_PROGRESS')this.idempotency.fail(scope,effectiveKey,redactError(error));
      throw error;
    }
  }

  public hasBlockingTaskOperation(taskId:string):boolean{
    const row=this.db.raw.prepare("SELECT 1 FROM persistent_operations WHERE task_id=? AND status IN ('RUNNING','UNKNOWN') LIMIT 1").get(taskId);
    return row!==undefined;
  }

  public reconcileAfterRestart():number{
    const now=new Date().toISOString();
    const safe=JSON.stringify({message:'Agent restarted before persistent operation completion'});
    const result=this.db.raw.prepare("UPDATE persistent_operations SET status='UNKNOWN',finished_at=?,error_json=? WHERE status='RUNNING'").run(now,safe);
    return Number(result.changes);
  }

  public async shutdown():Promise<void>{
    this.shuttingDown=true;
    await Promise.allSettled([...this.active.values()]);
  }

  private async execute(operationId:string,projectId:string,ownerId:string,run:()=>Promise<PersistentOperationResult>):Promise<void>{
    const renewEvery=Math.max(1_000,Math.floor(this.leaseTtlMs/3));
    const timer=setInterval(()=>{try{this.leases.renew(projectId,ownerId,this.leaseTtlMs);}catch{}},renewEvery);
    timer.unref?.();
    try{
      const outcome=await run();
      const safe=redactValue(outcome.result);
      if(outcome.succeeded===false){
        const safeError=redactValue(outcome.error??{message:'Persistent operation reported failure'});
        this.db.raw.prepare("UPDATE persistent_operations SET status='FAILED',target_id=?,finished_at=?,result_json=?,error_json=? WHERE operation_id=?")
          .run(outcome.targetId??null,new Date().toISOString(),JSON.stringify(safe),JSON.stringify(safeError),operationId);
      }else{
        this.db.raw.prepare("UPDATE persistent_operations SET status='SUCCEEDED',target_id=?,finished_at=?,result_json=? WHERE operation_id=?")
          .run(outcome.targetId??null,new Date().toISOString(),JSON.stringify(safe),operationId);
      }
    }catch(error){
      const safe=redactError(error);
      this.db.raw.prepare("UPDATE persistent_operations SET status='FAILED',finished_at=?,error_json=? WHERE operation_id=?")
        .run(new Date().toISOString(),JSON.stringify(safe),operationId);
    }finally{
      clearInterval(timer);
      this.leases.release(projectId,ownerId);
      this.active.delete(operationId);
    }
  }

  private getRequired(operationId:string):PersistentOperationRecord{
    const record=this.get(operationId);
    if(record===null)throw new ValidationError('Persistent operation not found');
    return record;
  }
}

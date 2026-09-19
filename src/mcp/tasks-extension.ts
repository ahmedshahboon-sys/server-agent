import type { Authorizer, ProjectStore } from '../core/interfaces.js';
import type { Principal, ProjectPermission } from '../core/types.js';
import { AuthorizationError, ValidationError } from '../core/errors.js';
import type { PersistentOperationManager, PersistentOperationRecord, PersistentOperationType } from '../operations/persistent-operation.js';
import { redactValue } from '../security/redaction.js';

export const MCP_TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

function permissionFor(type:PersistentOperationType,mode:'read'|'run'):ProjectPermission{
  if(type==='DEPLOYMENT')return mode==='read'?'deploy:read':'deploy:run';
  if(type==='ROLLBACK')return mode==='read'?'rollback:read':'rollback:run';
  if(type==='RECOVERY')return mode==='read'?'recovery:read':'recovery:run';
  return 'commands:run';
}

function messageFromError(value:unknown):string{
  if(value!==null&&typeof value==='object'&&!Array.isArray(value)){
    const message=(value as Record<string,unknown>)['message'];
    if(typeof message==='string'&&message.trim()!=='')return message.slice(0,1000);
  }
  return 'Persistent operation failed';
}

export class McpTasksExtension {
  public constructor(
    private readonly operations:PersistentOperationManager,
    private readonly projects:ProjectStore,
    private readonly authorizer:Authorizer,
  ){}

  public create(operationId:string,principal:Principal):Readonly<Record<string,unknown>>{
    const operation=this.requireOperation(operationId,principal,'read');
    return this.task(operation,false);
  }

  public get(taskId:string,principal:Principal):Readonly<Record<string,unknown>>{
    const operation=this.requireOperation(taskId,principal,'read');
    return this.task(operation,true);
  }

  public update(taskId:string,principal:Principal):Readonly<Record<string,unknown>>{
    this.requireOperation(taskId,principal,'run');
    return {resultType:'complete'};
  }

  public cancel(taskId:string,principal:Principal):Readonly<Record<string,unknown>>{
    const operation=this.requireOperation(taskId,principal,'run');
    if(operation.status==='RUNNING')this.operations.requestCancellation(taskId);
    return {resultType:'complete'};
  }

  private requireOperation(operationId:string,principal:Principal,mode:'read'|'run'):PersistentOperationRecord{
    if(!/^[A-Fa-f0-9-]{16,128}$/.test(operationId))throw new ValidationError('MCP task id is invalid');
    const operation=this.operations.get(operationId);
    if(operation===null)throw new ValidationError('MCP task was not found');
    const permission=permissionFor(operation.type,mode);
    this.authorizer.assertAllowed(principal,permission,operation.projectId);
    const project=this.projects.get(operation.projectId);
    if(project===null||!project.enabled)throw new ValidationError('Project is not available');
    if(!project.permissions.includes(permission))throw new AuthorizationError(`Project does not permit ${permission}`);
    return operation;
  }

  private task(operation:PersistentOperationRecord,detailed:boolean):Readonly<Record<string,unknown>>{
    const base:Record<string,unknown>={
      resultType:detailed?'complete':'task',
      taskId:operation.operationId,
      status:operation.status==='RUNNING'?'working':operation.status==='SUCCEEDED'?'completed':'failed',
      createdAt:operation.createdAt,
      lastUpdatedAt:operation.cancelRequestedAt??operation.finishedAt??operation.startedAt,
      ttlMs:null,
      pollIntervalMs:1000,
    };
    if(operation.status==='RUNNING'&&operation.cancelRequestedAt!==null){
      base['statusMessage']='Cancellation was requested. The underlying operation is safety-critical and continues until it reaches a verified safe state.';
    }else if(operation.status==='UNKNOWN'){
      base['statusMessage']='Operation state became unknown after a runtime interruption; inspect recovery evidence before further mutation.';
    }
    if(detailed&&operation.status==='SUCCEEDED'){
      const value=redactValue(operation.result);
      base['result']={
        resultType:'complete',
        content:[{type:'text',text:JSON.stringify(value)}],
        structuredContent:value,
        isError:false,
      };
    }else if(detailed&&(operation.status==='FAILED'||operation.status==='UNKNOWN')){
      base['error']={
        code:-32050,
        message:operation.status==='UNKNOWN'?'Persistent operation state is unknown after runtime interruption':messageFromError(operation.error),
        data:{operationStatus:operation.status},
      };
    }
    return base;
  }
}

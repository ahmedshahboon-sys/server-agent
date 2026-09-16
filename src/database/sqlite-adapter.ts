import { Worker } from 'node:worker_threads';
import type { DatabaseAdapter, DatabaseMigrationStatus, DatabaseQueryRequest, DatabaseQueryResult, DatabaseSchemaResult, DatabaseStatusResult } from './adapter.js';
import { DatabaseTimeoutError, ValidationError } from '../core/errors.js';

interface WorkerResponse<T>{readonly ok:boolean;readonly result?:T;readonly error?:{readonly name:string;readonly message:string};}
interface WorkerInput{readonly filename:string;readonly operation:'status'|'schema'|'query'|'transaction'|'migration';readonly timeoutMs:number;readonly maxRows?:number;readonly request?:DatabaseQueryRequest;readonly requests?:readonly DatabaseQueryRequest[];}

export class SqliteProjectAdapter implements DatabaseAdapter {
  public constructor(private readonly filename:string){}
  public status(timeoutMs:number):Promise<DatabaseStatusResult>{this.assertTimeout(timeoutMs);return this.run<DatabaseStatusResult>({filename:this.filename,operation:'status',timeoutMs},timeoutMs);}
  public schema(timeoutMs:number,maxRows:number):Promise<DatabaseSchemaResult>{this.assertTimeout(timeoutMs);return this.run<DatabaseSchemaResult>({filename:this.filename,operation:'schema',timeoutMs,maxRows},timeoutMs);}
  public query(request:DatabaseQueryRequest):Promise<DatabaseQueryResult>{this.assertTimeout(request.timeoutMs);return this.run<DatabaseQueryResult>({filename:this.filename,operation:'query',timeoutMs:request.timeoutMs,request},request.timeoutMs);}
  public transaction(requests:readonly DatabaseQueryRequest[]):Promise<readonly DatabaseQueryResult[]>{if(requests.length===0)throw new ValidationError('Transaction requires at least one statement');const timeout=Math.min(...requests.map((request)=>request.timeoutMs));this.assertTimeout(timeout);return this.run<readonly DatabaseQueryResult[]>({filename:this.filename,operation:'transaction',timeoutMs:timeout,requests},timeout);}
  public migrationStatus(timeoutMs:number):Promise<DatabaseMigrationStatus>{this.assertTimeout(timeoutMs);return this.run<DatabaseMigrationStatus>({filename:this.filename,operation:'migration',timeoutMs},timeoutMs);}
  public async close():Promise<void>{}
  private assertTimeout(timeoutMs:number):void{if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>120_000)throw new ValidationError('Database timeout must be 1-120000ms');}
  private run<T>(input:WorkerInput,timeoutMs:number):Promise<T>{return new Promise<T>((resolve,reject)=>{let settled=false;const worker=new Worker(new URL('./sqlite-worker.js',import.meta.url),{workerData:input});const timer=setTimeout(()=>{if(settled)return;settled=true;void worker.terminate();reject(new DatabaseTimeoutError(`Database operation timed out after ${timeoutMs}ms`));},timeoutMs);timer.unref();worker.once('message',(message:WorkerResponse<T>)=>{if(settled)return;settled=true;clearTimeout(timer);if(message.ok&&message.result!==undefined)resolve(message.result);else reject(new Error(message.error?.message??'SQLite worker failed'));});worker.once('error',(error)=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);});worker.once('exit',(code)=>{if(settled)return;settled=true;clearTimeout(timer);if(code!==0)reject(new Error(`SQLite worker exited with code ${code}`));else reject(new Error('SQLite worker exited without a result'));});});}
}

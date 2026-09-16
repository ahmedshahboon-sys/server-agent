import { randomUUID } from 'node:crypto';
import type { Authorizer, ProjectStore } from '../core/interfaces.js';
import type { DeploymentStatus, Principal, ProjectPermission, ProjectRecord } from '../core/types.js';
import { AuthorizationError, HealthCheckError, ValidationError } from '../core/errors.js';
import type { SqliteDatabase } from '../database/sqlite.js';
import type { DatabaseAdapterFactory } from '../database/database-service.js';
import type { DatabaseMigrationStatus } from '../database/adapter.js';
import { GitService } from '../git/git-service.js';
import { RestrictedCommandRunner } from '../commands/command-runner.js';
import { LocalValidationPipeline } from '../validation/local-ci.js';
import { TaskEngine } from '../tasks/task-engine.js';
import type { HealthCheckResult } from '../health/health-service.js';
import { HealthCheckService } from '../health/health-service.js';
import type { ServiceController } from '../services/service-controller.js';
import { redactError, redactValue } from '../security/redaction.js';

export interface DeploymentRecord {
  readonly deploymentId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly status: DeploymentStatus;
  readonly gitCommitBefore: string | null;
  readonly gitCommitAfter: string | null;
  readonly filesChanged: readonly string[];
  readonly commands: readonly unknown[];
  readonly startTime: string;
  readonly endTime: string | null;
  readonly service: string | null;
  readonly healthCheck: HealthCheckResult | null;
  readonly precheck: Readonly<Record<string, unknown>>;
  readonly result: unknown;
  readonly rollbackAvailable: boolean;
  readonly error: unknown;
}

type Row = {
  deployment_id:string;task_id:string;project_id:string;status:DeploymentStatus;git_commit_before:string|null;git_commit_after:string|null;
  files_changed_json:string;commands_json:string;start_time:string;end_time:string|null;service:string|null;health_check_json:string|null;
  precheck_json:string;result_json:string|null;rollback_available:number;error_json:string|null;
};
const parse=(value:string|null):unknown=>value===null?null:JSON.parse(value);
function map(row:Row):DeploymentRecord{return{deploymentId:row.deployment_id,taskId:row.task_id,projectId:row.project_id,status:row.status,gitCommitBefore:row.git_commit_before,gitCommitAfter:row.git_commit_after,filesChanged:parse(row.files_changed_json) as string[],commands:parse(row.commands_json) as unknown[],startTime:row.start_time,endTime:row.end_time,service:row.service,healthCheck:parse(row.health_check_json) as HealthCheckResult|null,precheck:parse(row.precheck_json) as Record<string,unknown>,result:parse(row.result_json),rollbackAvailable:row.rollback_available===1,error:parse(row.error_json)};}

function lines(value:string):string[]{return value.split(/\r?\n/).map((line)=>line.trim()).filter((line)=>line.length>0);}
function cleanStatus(status:string):boolean{const all=lines(status);return all.length===0||(all.length===1&&all[0]?.startsWith('##')===true);}
function systemPrincipal(projectId:string, permissions:readonly ProjectPermission[]):Principal{return{id:'deployment-engine',kind:'system',projectScopes:[projectId],permissions};}

export class DeploymentEngine {
  public constructor(
    private readonly db:SqliteDatabase,
    private readonly projects:ProjectStore,
    private readonly authorizer:Authorizer,
    private readonly git:GitService,
    private readonly runner:RestrictedCommandRunner,
    private readonly validation:LocalValidationPipeline,
    private readonly tasks:TaskEngine,
    private readonly health:HealthCheckService,
    private readonly services:ServiceController,
    private readonly databases:DatabaseAdapterFactory,
  ){}

  public get(deploymentId:string):DeploymentRecord|null{const row=this.db.raw.prepare('SELECT * FROM deployments WHERE deployment_id=?').get(deploymentId) as Row|undefined;return row===undefined?null:map(row);}
  public list(projectId:string):readonly DeploymentRecord[]{return (this.db.raw.prepare('SELECT * FROM deployments WHERE project_id=? ORDER BY start_time DESC').all(projectId) as Row[]).map(map);}

  public async deploy(taskId:string,projectId:string,principal:Principal):Promise<DeploymentRecord>{
    this.authorizer.assertAllowed(principal,'deploy:run',projectId);
    const project=this.projects.get(projectId);if(project===null||!project.enabled)throw new ValidationError('Project is not available');
    if(!project.permissions.includes('deploy:run'))throw new AuthorizationError('Project does not permit deployment');
    if(project.deployment.strategy==='none')throw new ValidationError('Project deployment is disabled');
    if(project.deployment.strategy==='command'&&project.commands.deploy===undefined)throw new ValidationError('Deploy command is not configured');
    if((project.deployment.restartService||project.deployment.strategy==='restart-only')&&project.serviceName===undefined)throw new ValidationError('Deployment requires a configured service');

    const internal=systemPrincipal(projectId,['git:read','commands:run','health:read','database:read']);
    const precheck=await this.precheck(taskId,project,internal);
    const deploymentId=randomUUID();const started=new Date().toISOString();
    this.db.raw.prepare('INSERT INTO deployments(deployment_id,task_id,project_id,status,git_commit_before,git_commit_after,files_changed_json,commands_json,start_time,end_time,service,health_check_json,precheck_json,result_json,rollback_available,error_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(deploymentId,taskId,projectId,'PREPARING',precheck.commitBefore,null,'[]','[]',started,null,project.serviceName??null,null,JSON.stringify(redactValue(precheck)),null,precheck.commitBefore!==null?1:0,null);
    this.tasks.setDeployment(taskId,deploymentId);this.tasks.setGitReferences(taskId,precheck.commitBefore,null);this.tasks.setRollbackState(taskId,{gitCommit:precheck.commitBefore,migrationStatus:precheck.migrationStatus});
    this.tasks.checkpoint(taskId,{currentStep:'deploy',completedSteps:['pre-deploy-checks'],remainingSteps:['deploy','health-check'],metadata:{deploymentId,commitBefore:precheck.commitBefore}});

    const commands:unknown[]=[];
    try{
      this.tasks.setStatus(taskId,'DEPLOYING');this.updateStatus(deploymentId,'DEPLOYING');
      if(project.deployment.strategy==='command'){
        const result=await this.runner.run(projectId,internal,'deploy');
        const summary={id:'deploy',exitCode:result.exitCode,durationMs:result.durationMs,truncated:result.stdoutTruncated||result.stderrTruncated};commands.push(summary);this.tasks.recordCommand(taskId,summary);
        if(result.exitCode!==0)throw new ValidationError('Deploy command failed',{exitCode:result.exitCode,stderr:result.stderr});
      }
      if(project.deployment.restartService||project.deployment.strategy==='restart-only'){
        if(project.serviceName===undefined)throw new ValidationError('Service is not configured');
        await this.services.restart(project.serviceName);commands.push({id:'service-restart',service:project.serviceName});this.tasks.recordCommand(taskId,{id:'service-restart',service:project.serviceName});
      }
      const detectedAfter=(await this.git.headCommit(projectId,internal)).stdout.trim();
      const after:string|null=detectedAfter!==''?detectedAfter:precheck.commitBefore;
      const filesChanged=precheck.commitBefore!==null&&after!==null&&after!==precheck.commitBefore?lines((await this.git.diffBetween(projectId,internal,precheck.commitBefore,after)).stdout):[];
      this.tasks.setGitReferences(taskId,precheck.commitBefore,after);
      this.db.raw.prepare('UPDATE deployments SET git_commit_after=?,files_changed_json=?,commands_json=? WHERE deployment_id=?').run(after,JSON.stringify(filesChanged),JSON.stringify(redactValue(commands)),deploymentId);

      this.tasks.setStatus(taskId,'HEALTH_CHECKING');this.updateStatus(deploymentId,'HEALTH_CHECKING');
      const health=await this.health.check(projectId,internal,{taskId,deploymentId});this.tasks.setHealthResult(taskId,health);
      this.db.raw.prepare('UPDATE deployments SET health_check_json=? WHERE deployment_id=?').run(JSON.stringify(health),deploymentId);
      if(project.deployment.healthRequired&&health.state!=='HEALTHY')throw new HealthCheckError(`Post-deploy health is ${health.state}`);

      const finished=new Date().toISOString();
      this.db.raw.prepare("UPDATE deployments SET status='SUCCEEDED',end_time=?,result_json=?,commands_json=? WHERE deployment_id=?").run(finished,JSON.stringify({ok:true}),JSON.stringify(redactValue(commands)),deploymentId);
      this.tasks.checkpoint(taskId,{currentStep:'completed',completedSteps:['pre-deploy-checks','deploy','health-check'],remainingSteps:[],metadata:{deploymentId,health:health.state}});this.tasks.setStatus(taskId,'COMPLETED');
      return this.getRequired(deploymentId);
    }catch(error){
      const finished=new Date().toISOString();const safe=redactError(error);
      this.db.raw.prepare("UPDATE deployments SET status='FAILED',end_time=?,error_json=?,commands_json=? WHERE deployment_id=?").run(finished,JSON.stringify(safe),JSON.stringify(redactValue(commands)),deploymentId);
      this.tasks.recordError(taskId,safe);
      return this.getRequired(deploymentId);
    }
  }

  private async precheck(taskId:string,project:ProjectRecord,principal:Principal):Promise<{commitBefore:string|null;branch:string;clean:boolean;changedFiles:readonly string[];diffSummary:string;validation:unknown;migrationStatus:unknown}>{
    const status=await this.git.status(project.id,principal);if(status.exitCode!==0)throw new ValidationError('Git status failed');
    const branch=(await this.git.branch(project.id,principal)).stdout.trim();
    if(project.deployment.branch!==undefined&&branch!==project.deployment.branch)throw new ValidationError(`Deployment branch must be ${project.deployment.branch}`);
    const clean=cleanStatus(status.stdout);if(project.deployment.requireClean&&!clean)throw new ValidationError('Deployment requires a clean Git working tree');
    const commitBefore=(await this.git.headCommit(project.id,principal)).stdout.trim()||null;
    const changedFiles=lines((await this.git.changedFiles(project.id,principal)).stdout);
    const diffSummary=(await this.git.diffStat(project.id,principal)).stdout.trim();
    let validation:unknown={skipped:true};if(project.deployment.validationRequired){const result=await this.validation.run(taskId,project.id,principal);validation=result;if(!result.passed)throw new ValidationError('Pre-deploy validation failed');}
    let migrationStatus:DatabaseMigrationStatus|Readonly<Record<string,unknown>>={known:false,system:null,current:null,pending:null,details:{skipped:true}};
    if(project.database.adapter!=='none'){
      const adapter=await this.databases.create(project);try{migrationStatus=await adapter.migrationStatus(5_000);}finally{await adapter.close();}
    }
    return{commitBefore,branch,clean,changedFiles,diffSummary,validation:redactValue(validation),migrationStatus:redactValue(migrationStatus)};
  }

  private updateStatus(deploymentId:string,status:DeploymentStatus):void{this.db.raw.prepare('UPDATE deployments SET status=? WHERE deployment_id=?').run(status,deploymentId);}
  private getRequired(id:string):DeploymentRecord{const record=this.get(id);if(record===null)throw new ValidationError('Deployment record not found');return record;}
}

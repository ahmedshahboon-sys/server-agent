import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../database/sqlite.js';
import type { Principal } from '../core/types.js';
import type { ProjectStore } from '../core/interfaces.js';
import { AttemptLimitError, ValidationError } from '../core/errors.js';
import { RestrictedCommandRunner } from '../commands/command-runner.js';
import { redactError, redactValue } from '../security/redaction.js';

export interface ValidationStepResult { readonly name:string; readonly exitCode:number|null; readonly stdout:string; readonly stderr:string; readonly durationMs:number; readonly passed:boolean; readonly truncated:boolean; }
export interface ValidationResult { readonly validationId:string; readonly attempt:number; readonly passed:boolean; readonly steps:readonly ValidationStepResult[]; }

export class LocalValidationPipeline {
  public constructor(private readonly db:SqliteDatabase,private readonly projects:ProjectStore,private readonly runner:RestrictedCommandRunner,private readonly maxAttempts:number){}
  public async run(taskId:string,projectId:string,principal:Principal):Promise<ValidationResult>{
    const project=this.projects.get(projectId);if(project===null||!project.enabled)throw new ValidationError('Project is not available');
    const prior=(this.db.raw.prepare('SELECT COUNT(*) AS n FROM validation_runs WHERE task_id=? AND project_id=?').get(taskId,projectId) as {n:number}).n;const attempt=prior+1;if(attempt>this.maxAttempts)throw new AttemptLimitError(`Validation attempt limit (${this.maxAttempts}) reached`);
    const steps=project.commands.validation??['test','build'].filter(name=>name==='test'?project.commands.test!==undefined:project.commands.build!==undefined);if(steps.length===0)throw new ValidationError('Project has no validation pipeline configured');
    const id=randomUUID(),started=new Date().toISOString(),results:ValidationStepResult[]=[];let passed=true;
    for(const name of steps){try{const r=await this.runner.run(projectId,principal,name);const step={name,exitCode:r.exitCode,stdout:r.stdout,stderr:r.stderr,durationMs:r.durationMs,passed:r.exitCode===0,truncated:r.stdoutTruncated||r.stderrTruncated};results.push(step);if(!step.passed){passed=false;break;}}catch(error){results.push({name,exitCode:null,stdout:'',stderr:JSON.stringify(redactError(error)),durationMs:0,passed:false,truncated:false});passed=false;break;}}
    this.db.raw.prepare('INSERT INTO validation_runs(validation_id,task_id,project_id,attempt,started_at,finished_at,passed,result_json) VALUES(?,?,?,?,?,?,?,?)').run(id,taskId,projectId,attempt,started,new Date().toISOString(),passed?1:0,JSON.stringify(redactValue(results)));
    const taskRow=this.db.raw.prepare('SELECT tests_run_json,test_results_json FROM tasks WHERE task_id=?').get(taskId) as {tests_run_json:string;test_results_json:string}|undefined;
    if(taskRow!==undefined){const names=JSON.parse(taskRow.tests_run_json) as string[];const priorResults=JSON.parse(taskRow.test_results_json) as unknown[];for(const step of results){if(!names.includes(step.name))names.push(step.name);priorResults.push(redactValue(step));}this.db.raw.prepare('UPDATE tasks SET tests_run_json=?,test_results_json=?,updated_at=? WHERE task_id=?').run(JSON.stringify(names),JSON.stringify(priorResults),new Date().toISOString(),taskId);}
    return{validationId:id,attempt,passed,steps:results};
  }
}

import { booleanArg, numberArg, stringArg, stringArrayArg } from '../arguments.js';
import type { McpToolRegistry } from '../tool-registry.js';
import { objectSchema, projectIdSchema, stringSchema } from './schema-helpers.js';
import type { GitService } from '../../git/git-service.js';
import type { JobManager } from '../../jobs/job-manager.js';
import type { LocalValidationPipeline } from '../../validation/local-ci.js';
import type { PersistentOperationManager } from '../../operations/persistent-operation.js';
import { ValidationError } from '../../core/errors.js';

export function registerGitCommandTools(registry:McpToolRegistry,git:GitService,jobs:JobManager,validation:LocalValidationPipeline,operations:PersistentOperationManager):void{
  registry.register({definition:{name:'git_status',description:'Get bounded Git status for a project.',inputSchema:objectSchema({project_id:projectIdSchema},['project_id'])},permission:'git:read',projectArgument:'project_id',handler:async(args,ctx)=>git.status(stringArg(args,'project_id')??'',ctx.principal)});
  registry.register({definition:{name:'git_diff',description:'Get bounded Git diff for a project.',inputSchema:objectSchema({project_id:projectIdSchema,staged:{type:'boolean'}},['project_id'])},permission:'git:read',projectArgument:'project_id',handler:async(args,ctx)=>git.diff(stringArg(args,'project_id')??'',ctx.principal,booleanArg(args,'staged',true)??false)});
  registry.register({definition:{name:'git_log',description:'Get recent Git history.',inputSchema:objectSchema({project_id:projectIdSchema,limit:{type:'number',minimum:1,maximum:100}},['project_id'])},permission:'git:read',projectArgument:'project_id',handler:async(args,ctx)=>git.log(stringArg(args,'project_id')??'',ctx.principal,numberArg(args,'limit',{optional:true,min:1,max:100})??20)});
  registry.register({definition:{name:'git_branch',description:'Get the current Git branch.',inputSchema:objectSchema({project_id:projectIdSchema},['project_id'])},permission:'git:read',projectArgument:'project_id',handler:async(args,ctx)=>git.branch(stringArg(args,'project_id')??'',ctx.principal)});
  registry.register({definition:{name:'git_commit',description:'Create a Git commit containing only explicitly listed project paths. Existing unrelated staged changes are excluded.',inputSchema:objectSchema({project_id:projectIdSchema,message:stringSchema,paths:{type:'array',items:{type:'string'},minItems:1,maxItems:256}},['project_id','message','paths'])},permission:'git:write',projectArgument:'project_id',mutating:true,handler:async(args,ctx)=>git.commit(stringArg(args,'project_id')??'',ctx.principal,stringArg(args,'message',{max:200})??'',stringArrayArg(args,'paths')??[])});
  registry.register({definition:{name:'run_command',description:'Start one project-registered command as a persistent bounded job. Optional task_id links cancellation and task state to the job.',inputSchema:objectSchema({project_id:projectIdSchema,command_id:stringSchema,task_id:stringSchema},['project_id','command_id'])},permission:'commands:run',projectArgument:'project_id',mutating:true,handler:async(args,ctx)=>jobs.start(stringArg(args,'project_id')??'',ctx.principal,stringArg(args,'command_id',{max:128})??'',stringArg(args,'task_id',{optional:true,max:128}))});
  registry.register({definition:{name:'run_tests',description:'Start the project registered test command as a persistent bounded job. Optional task_id links it to a running task.',inputSchema:objectSchema({project_id:projectIdSchema,task_id:stringSchema},['project_id'])},permission:'commands:run',projectArgument:'project_id',mutating:true,handler:async(args,ctx)=>jobs.start(stringArg(args,'project_id')??'',ctx.principal,'test',stringArg(args,'task_id',{optional:true,max:128}))});
  registry.register({definition:{name:'run_validation',description:'Start project Local CI as a durable operation and return operation_id immediately.',inputSchema:objectSchema({project_id:projectIdSchema,task_id:stringSchema},['project_id','task_id'])},permission:'commands:run',projectArgument:'project_id',mutating:true,handler:async(args,ctx)=>{
    const projectId=stringArg(args,'project_id')??'',taskId=stringArg(args,'task_id',{max:128})??'';
    return operations.start('VALIDATION',projectId,taskId,async()=>{const result=await validation.run(taskId,projectId,ctx.principal);return result.passed?{targetId:result.validationId,result}:{targetId:result.validationId,result,succeeded:false,error:{message:'Validation failed'}};});
  }});
  registry.register({definition:{name:'validation_operation_status',description:'Read one durable validation operation.',inputSchema:objectSchema({project_id:projectIdSchema,operation_id:stringSchema},['project_id','operation_id'])},permission:'commands:run',projectArgument:'project_id',handler:async(args)=>{
    const projectId=stringArg(args,'project_id')??'',operationId=stringArg(args,'operation_id',{max:128})??'';const operation=operations.get(operationId);
    if(operation===null||operation.projectId!==projectId||operation.type!=='VALIDATION')throw new ValidationError('Validation operation is not available for this project');
    return operation;
  }});
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { AuthorizationError, ValidationError } from '../../src/core/errors.js';
import { McpToolRegistry } from '../../src/mcp/tool-registry.js';
import { registerProjectTools } from '../../src/mcp/tools/project-tools.js';
import { projectInput } from '../../src/mcp/arguments.js';
import { projectFixture } from '../helpers.js';

const authorizer=new DefaultDenyAuthorizer();

test('MCP project boundary requires project capability in addition to principal permission and scope', async()=>{
  const db=new SqliteDatabase(':memory:');
  try{
    const projects=new ProjectRegistry(db);
    projects.create(projectFixture({permissions:['project:read']}));
    const tools=new McpToolRegistry(authorizer,db,projects);
    tools.register({
      definition:{name:'capability_probe',description:'probe',inputSchema:{type:'object'}},
      permission:'files:read',projectArgument:'project_id',
      handler:async()=>({ok:true}),
    });
    const principal={id:'remote',kind:'remote' as const,projectScopes:['project-a'],permissions:['files:read'] as const};
    await assert.rejects(tools.call('capability_probe',{project_id:'project-a'},{principal,requestId:1}),AuthorizationError);
  }finally{db.close();}
});

test('project update permissions are field-specific and root changes require global scope', async()=>{
  const db=new SqliteDatabase(':memory:');
  try{
    const projects=new ProjectRegistry(db);
    projects.create(projectFixture());
    const tools=new McpToolRegistry(authorizer,db,projects);
    registerProjectTools(tools,projects);

    const metadataPrincipal={
      id:'metadata-admin',kind:'remote' as const,projectScopes:['project-a'],
      permissions:['project:read','project:update:metadata'] as const,
    };
    const renamed=projectFixture({name:'Renamed'});
    const result=await tools.call('update_project',{project_id:'project-a',project:renamed},{principal:metadataPrincipal,requestId:2}) as {name:string};
    assert.equal(result.name,'Renamed');

    const rootAttempt=projectFixture({name:'Renamed',root:'/opt/other'});
    await assert.rejects(tools.call('update_project',{project_id:'project-a',project:rootAttempt},{principal:metadataPrincipal,requestId:3}),AuthorizationError);

    const scopedRootPrincipal={
      id:'root-admin',kind:'remote' as const,projectScopes:['project-a'],
      permissions:['project:read','project:update:root'] as const,
    };
    await assert.rejects(tools.call('update_project',{project_id:'project-a',project:rootAttempt},{principal:scopedRootPrincipal,requestId:4}),AuthorizationError);

    const globalRootPrincipal={
      id:'root-admin-global',kind:'remote' as const,projectScopes:['*'],
      permissions:['project:read','project:update:root'] as const,
    };
    const moved=await tools.call('update_project',{project_id:'project-a',project:rootAttempt},{principal:globalRootPrincipal,requestId:5}) as {root:string};
    assert.equal(moved.root,'/opt/other');
  }finally{db.close();}
});

test('read-only project principal cannot perform no-op update or mutate capabilities', async()=>{
  const db=new SqliteDatabase(':memory:');
  try{
    const projects=new ProjectRegistry(db);
    projects.create(projectFixture());
    const tools=new McpToolRegistry(authorizer,db,projects);
    registerProjectTools(tools,projects);
    const readOnly={id:'reader',kind:'remote' as const,projectScopes:['project-a'],permissions:['project:read'] as const};
    await assert.rejects(tools.call('update_project',{project_id:'project-a',project:projectFixture()},{principal:readOnly,requestId:6}),ValidationError);
    const escalated=projectFixture({permissions:['project:read','files:read','files:write']});
    await assert.rejects(tools.call('update_project',{project_id:'project-a',project:escalated},{principal:readOnly,requestId:7}),AuthorizationError);
  }finally{db.close();}
});

test('project capabilities reject registry-management permissions and nested unknown fields',()=>{
  const db=new SqliteDatabase(':memory:');
  try{
    const projects=new ProjectRegistry(db);
    assert.throws(()=>projects.create(projectFixture({permissions:['project:read','project:update:root']})),ValidationError);
    const malformed={...projectFixture(),health:{type:'http',path:'/health',timeoutMs:5000,unexpected:true}};
    assert.throws(()=>projectInput(malformed),ValidationError);
    assert.throws(()=>projects.create(malformed as ReturnType<typeof projectFixture>),ValidationError);
  }finally{db.close();}
});

test('disabled project can be re-enabled only with explicit state-management permission',async()=>{
  const db=new SqliteDatabase(':memory:');
  try{
    const projects=new ProjectRegistry(db);
    projects.create(projectFixture());
    projects.disable('project-a');
    const tools=new McpToolRegistry(authorizer,db,projects);
    registerProjectTools(tools,projects);
    const reader={id:'reader',kind:'remote' as const,projectScopes:['project-a'],permissions:['project:read'] as const};
    await assert.rejects(tools.call('enable_project',{project_id:'project-a'},{principal:reader,requestId:8}),AuthorizationError);
    const stateAdmin={id:'state-admin',kind:'remote' as const,projectScopes:['project-a'],permissions:['project:update:state'] as const};
    const enabled=await tools.call('enable_project',{project_id:'project-a'},{principal:stateAdmin,requestId:9}) as {enabled:boolean};
    assert.equal(enabled.enabled,true);
  }finally{db.close();}
});

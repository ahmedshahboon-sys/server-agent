import test from 'node:test';
import assert from 'node:assert/strict';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { StaticBearerAuthenticator } from '../../src/mcp/auth.js';
import { McpToolRegistry } from '../../src/mcp/tool-registry.js';
import { MCP_PROTOCOL_VERSION, McpHttpTransport } from '../../src/mcp/transport.js';
import { MCP_TASKS_EXTENSION, type McpTasksExtension } from '../../src/mcp/tasks-extension.js';

const token='group7-task-token-0123456789abcdef';
const principal={id:'remote-a',kind:'remote' as const,projectScopes:['*'],permissions:['project:read'] as const};
const auth=new StaticBearerAuthenticator(token,principal);
const meta=(tasks:boolean)=>({
  'io.modelcontextprotocol/protocolVersion':MCP_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientCapabilities':tasks?{extensions:{[MCP_TASKS_EXTENSION]:{}}}:{},
});
const headers=(method:string,name?:string)=>({
  'content-type':'application/json',
  authorization:`Bearer ${token}`,
  'mcp-protocol-version':MCP_PROTOCOL_VERSION,
  'mcp-method':method,
  ...(name===undefined?{}:{'mcp-name':name}),
});
const rpc=(id:number,method:string,params:Record<string,unknown>)=>JSON.stringify({jsonrpc:'2.0',id,method,params});

test('MCP Tasks are negotiated per request and use taskId routing header',async()=>{
  const tools=new McpToolRegistry(new DefaultDenyAuthorizer());
  tools.register({
    definition:{name:'durable_probe',description:'durable probe',inputSchema:{type:'object'}},
    permission:'project:read',taskBacked:true,
    handler:async()=>({operationId:'12345678-1234-1234-1234-123456789abc'}),
  });
  const fakeTasks={
    create:(id:string)=>({resultType:'task',taskId:id,status:'working',createdAt:'2026-09-19T00:00:00.000Z',lastUpdatedAt:'2026-09-19T00:00:00.000Z',ttlMs:null,pollIntervalMs:1000}),
    get:(id:string)=>({resultType:'complete',taskId:id,status:'working',createdAt:'2026-09-19T00:00:00.000Z',lastUpdatedAt:'2026-09-19T00:00:00.000Z',ttlMs:null,pollIntervalMs:1000}),
    update:()=>({resultType:'complete'}),
    cancel:()=>({resultType:'complete'}),
  } as unknown as McpTasksExtension;
  const transport=new McpHttpTransport(auth,tools,{path:'/mcp',maxBodyBytes:16384,allowedOrigins:[]},fakeTasks);
  const call=await transport.handle({method:'POST',path:'/mcp',headers:headers('tools/call','durable_probe'),body:rpc(1,'tools/call',{name:'durable_probe',arguments:{},_meta:meta(true)})});
  assert.equal(call.status,200);
  const taskId=(JSON.parse(call.body).result?.taskId) as string;
  assert.equal(taskId,'12345678-1234-1234-1234-123456789abc');
  assert.equal(JSON.parse(call.body).result?.resultType,'task');

  const missingName=await transport.handle({method:'POST',path:'/mcp',headers:headers('tasks/get'),body:rpc(2,'tasks/get',{taskId,_meta:meta(true)})});
  assert.equal(missingName.status,400);

  const get=await transport.handle({method:'POST',path:'/mcp',headers:headers('tasks/get',taskId),body:rpc(3,'tasks/get',{taskId,_meta:meta(true)})});
  assert.equal(get.status,200);
  assert.equal(JSON.parse(get.body).result?.resultType,'complete');

  const missingCapability=await transport.handle({method:'POST',path:'/mcp',headers:headers('tasks/get',taskId),body:rpc(4,'tasks/get',{taskId,_meta:meta(false)})});
  assert.equal(missingCapability.status,400);
  assert.equal(JSON.parse(missingCapability.body).error?.code,-32021);
});

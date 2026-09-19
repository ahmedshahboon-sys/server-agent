import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { McpToolRegistry } from '../../src/mcp/tool-registry.js';
import { McpHttpTransport, MCP_PROTOCOL_VERSION } from '../../src/mcp/transport.js';
import { RejectAllAuthenticator, StaticBearerAuthenticator } from '../../src/mcp/auth.js';

const challenge='Bearer resource_metadata="https://agent.example.com/.well-known/oauth-protected-resource", scope="mcp:read"';
const principal={
  id:'chatgpt-oauth',
  kind:'remote' as const,
  projectScopes:['*'],
  permissions:['project:read'] as const,
};

function listRequest(token?:string){
  const body=JSON.stringify({
    jsonrpc:'2.0',
    id:'oauth-list',
    method:'tools/list',
    params:{
      _meta:{
        'io.modelcontextprotocol/protocolVersion':MCP_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientCapabilities':{},
      },
    },
  });
  return {
    method:'POST',
    path:'/mcp',
    headers:{
      'content-type':'application/json',
      'mcp-protocol-version':MCP_PROTOCOL_VERSION,
      'mcp-method':'tools/list',
      ...(token===undefined?{}:{authorization:`Bearer ${token}`}),
    },
    body,
    remoteAddress:'127.0.0.1',
  };
}

test('MCP returns OAuth discovery challenge on unauthenticated requests',async()=>{
  const db=new SqliteDatabase(':memory:');
  try{
    const registry=new McpToolRegistry(new DefaultDenyAuthorizer(),db,undefined,undefined,['mcp:read']);
    registry.register({definition:{name:'oauth_probe',description:'probe',inputSchema:{type:'object'}},permission:'project:read',handler:async()=>({ok:true})});
    const transport=new McpHttpTransport(new RejectAllAuthenticator(),registry,{
      path:'/mcp',maxBodyBytes:1024*1024,allowedOrigins:[],authChallenge:challenge,
    });
    const response=await transport.handle(listRequest());
    assert.equal(response.status,401);
    assert.equal(response.headers['www-authenticate'],challenge);
  }finally{db.close();}
});

test('OAuth-enabled tools/list advertises oauth2 securitySchemes',async()=>{
  const db=new SqliteDatabase(':memory:');
  try{
    const token='oauth-transport-token-0123456789abcdef';
    const registry=new McpToolRegistry(new DefaultDenyAuthorizer(),db,undefined,undefined,['mcp:read']);
    registry.register({definition:{name:'oauth_probe',description:'probe',inputSchema:{type:'object'}},permission:'project:read',handler:async()=>({ok:true})});
    const transport=new McpHttpTransport(new StaticBearerAuthenticator(token,principal),registry,{
      path:'/mcp',maxBodyBytes:1024*1024,allowedOrigins:[],authChallenge:challenge,
    });
    const response=await transport.handle(listRequest(token));
    assert.equal(response.status,200);
    const parsed=JSON.parse(response.body);
    const tool=parsed.result.tools.find((item:{name:string})=>item.name==='oauth_probe');
    assert.deepEqual(tool.securitySchemes,[{type:'oauth2',scopes:['mcp:read']}]);
  }finally{db.close();}
});

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const token='group6-sdk-compat-token-0123456789abcdef012345';
const protocol='2026-07-28';
const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));

async function freePort(){
  return new Promise((resolve,reject)=>{
    const server=net.createServer();
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{
      const address=server.address();
      if(address===null||typeof address==='string'){server.close();reject(new Error('unable to allocate port'));return;}
      const port=address.port;
      server.close((error)=>error===undefined?resolve(port):reject(error));
    });
  });
}

const temp=await mkdtemp(path.join(os.tmpdir(),'server-agent-sdk-compat-'));
const port=await freePort();
let stderr='';
const child=spawn(process.execPath,['dist/runtime/server-agent.js'],{
  cwd:process.cwd(),
  env:{
    ...process.env,
    SERVER_AGENT_DATA_DIR:temp,
    SERVER_AGENT_DB_PATH:path.join(temp,'state.sqlite'),
    SERVER_AGENT_MCP_HOST:'127.0.0.1',
    SERVER_AGENT_MCP_PORT:String(port),
    SERVER_AGENT_MCP_PATH:'/mcp',
    SERVER_AGENT_MCP_ALLOW_PUBLIC_BIND:'false',
    SERVER_AGENT_MCP_PROJECT_SCOPES:'*',
    SERVER_AGENT_MCP_PERMISSIONS:'project:read',
    SERVER_AGENT_MCP_BEARER_TOKEN:token,
    SERVER_AGENT_MCP_CREDENTIAL_ID:'sdk-compat',
    SERVER_AGENT_AUTH_ATTEMPTS_PER_MINUTE:'100',
    SERVER_AGENT_AUTH_REQUESTS_PER_MINUTE:'100',
  },
  stdio:['ignore','ignore','pipe'],
});
child.stderr.on('data',(chunk)=>{stderr+=String(chunk);});

try{
  for(let attempt=0;attempt<50;attempt+=1){
    if(child.exitCode!==null)throw new Error(`runtime exited before SDK compatibility test: ${stderr.slice(0,1000)}`);
    try{
      const response=await fetch(`http://127.0.0.1:${port}/mcp`,{
        method:'POST',
        headers:{
          'content-type':'application/json',
          authorization:`Bearer ${token}`,
          'mcp-protocol-version':protocol,
          'mcp-method':'server/discover',
        },
        body:JSON.stringify({
          jsonrpc:'2.0',id:'readiness',method:'server/discover',
          params:{_meta:{
            'io.modelcontextprotocol/protocolVersion':protocol,
            'io.modelcontextprotocol/clientInfo':{name:'readiness',version:'1.0.0'},
            'io.modelcontextprotocol/clientCapabilities':{},
          }},
        }),
      });
      if(response.ok)break;
    }catch{}
    await sleep(100);
  }

  const client=new Client(
    {name:'server-agent-sdk-compat',version:'1.0.0'},
    {versionNegotiation:{mode:'auto'}},
  );
  const transport=new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    {requestInit:{headers:{Authorization:`Bearer ${token}`}}},
  );

  await client.connect(transport);
  if(client.getNegotiatedProtocolVersion()!==protocol){
    throw new Error(`official SDK negotiated unexpected protocol: ${client.getNegotiatedProtocolVersion()}`);
  }
  const discover=client.getDiscoverResult();
  if(discover===undefined||!discover.supportedVersions.includes(protocol)){
    throw new Error('official SDK did not receive modern server discovery');
  }

  const listed=await client.listTools();
  const names=new Set(listed.tools.map((tool)=>tool.name));
  if(!names.has('system_snapshot'))throw new Error('official SDK tools/list did not expose expected tool');

  const called=await client.callTool({name:'system_snapshot',arguments:{}});
  if(called.isError===true)throw new Error('official SDK tools/call returned isError=true');
  if(called.structuredContent===undefined)throw new Error('official SDK tools/call did not receive structuredContent');

  await client.close();
  console.log(`Official MCP SDK compatibility passed (protocol=${protocol}, tools=${names.size}).`);
}finally{
  if(child.exitCode===null)child.kill('SIGTERM');
  for(let attempt=0;attempt<50&&child.exitCode===null;attempt+=1)await sleep(100);
  if(child.exitCode===null)child.kill('SIGKILL');
  await rm(temp,{recursive:true,force:true});
}

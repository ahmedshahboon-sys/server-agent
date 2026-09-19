import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { AuthenticationStore } from '../../src/security/auth-store.js';
import { PersistentBearerAuthenticator } from '../../src/mcp/auth.js';
import { AuthenticationError, ConflictError, RateLimitError } from '../../src/core/errors.js';
import { McpToolRegistry } from '../../src/mcp/tool-registry.js';
import { DefaultDenyAuthorizer } from '../../src/security/authorization.js';
import { requestHostControl } from '../../src/host/control-client.js';
import { tempDir } from '../helpers.js';

const tokenA='group5-token-a-0123456789abcdef0123456789';
const tokenB='group5-token-b-0123456789abcdef0123456789';
const tokenC='group5-token-c-0123456789abcdef0123456789';

const principalA={
  id:'principal-a',kind:'remote' as const,projectScopes:['project-a'],permissions:['project:read','files:read'] as const,
};
const principalB={
  id:'principal-b',kind:'remote' as const,projectScopes:['project-b'],permissions:['project:read'] as const,
};

test('persistent bearer store supports multiple principals and never stores raw bearer tokens',()=>{
  const db=new SqliteDatabase(':memory:');
  try{
    const store=new AuthenticationStore(db);
    store.createCredential(principalA,'cred-a',tokenA);
    store.createCredential(principalB,'cred-b',tokenB,'2027-01-01T00:00:00Z');
    const rows=db.raw.prepare('SELECT credential_id,token_hash FROM auth_credentials ORDER BY credential_id').all() as unknown as Array<{credential_id:string;token_hash:string}>;
    assert.equal(rows.length,2);
    assert.equal(rows.some((row)=>row.token_hash.includes(tokenA)||row.token_hash.includes(tokenB)),false);
    assert.match(rows[0]!.token_hash,/^[a-f0-9]{64}$/);

    const authenticated=store.authenticate(tokenA,new Date('2026-09-19T03:00:00Z'));
    assert.equal(authenticated.id,'principal-a');
    assert.equal(authenticated.credentialId,'cred-a');
    assert.equal(store.listCredentials('principal-a')[0]?.lastUsedAt,'2026-09-19T03:00:00.000Z');
    const success=db.raw.prepare("SELECT COUNT(*) AS count FROM auth_audit WHERE principal_id='principal-a' AND outcome='SUCCESS'").get() as unknown as {count:number};
    assert.equal(Number(success.count),1);
  }finally{db.close();}
});

test('credential expiry revoke rotation and bootstrap collision fail closed',()=>{
  const db=new SqliteDatabase(':memory:');
  try{
    const store=new AuthenticationStore(db);
    store.bootstrapCredential(principalA,'bootstrap-a',tokenA);
    assert.doesNotThrow(()=>store.bootstrapCredential(principalA,'bootstrap-a',tokenA));
    assert.throws(()=>store.bootstrapCredential(principalA,'bootstrap-a',tokenB),ConflictError);

    const rotated=store.rotateCredential('bootstrap-a','rotated-a',tokenB,'2027-01-01T00:00:00Z');
    assert.equal(rotated.revokedAt,null);
    assert.throws(()=>store.authenticate(tokenA,new Date('2026-09-19T03:00:00Z')),AuthenticationError);
    assert.equal(store.authenticate(tokenB,new Date('2026-09-19T03:00:00Z')).credentialId,'rotated-a');

    store.revokeCredential('rotated-a');
    assert.throws(()=>store.authenticate(tokenB,new Date('2026-09-19T03:00:00Z')),AuthenticationError);

    store.createCredential(principalA,'expired-a',tokenC,'2026-01-01T00:00:00Z');
    assert.throws(()=>store.authenticate(tokenC,new Date('2026-09-19T03:00:00Z')),AuthenticationError);
  }finally{db.close();}
});

test('persistent authenticator enforces source and per-principal rate limits with auditable outcomes',async()=>{
  const db=new SqliteDatabase(':memory:');
  try{
    const store=new AuthenticationStore(db);
    store.createCredential(principalA,'cred-rate',tokenA);
    let now=new Date('2026-09-19T03:00:00Z');
    const auth=new PersistentBearerAuthenticator(store,{attemptsPerMinute:10,requestsPerMinute:1,now:()=>now});
    const header={authorization:`Bearer ${tokenA}`,remoteAddress:'127.0.0.1'};
    assert.equal((await auth.authenticate(header)).id,'principal-a');
    await assert.rejects(auth.authenticate({...header,remoteAddress:'127.0.0.2'}),RateLimitError);
    let limited=db.raw.prepare("SELECT COUNT(*) AS count FROM auth_audit WHERE outcome='RATE_LIMITED' AND principal_id='principal-a'").get() as unknown as {count:number};
    assert.equal(Number(limited.count),1);

    now=new Date('2026-09-19T03:01:01Z');
    assert.equal((await auth.authenticate(header)).id,'principal-a');

    const sourceLimited=new PersistentBearerAuthenticator(store,{attemptsPerMinute:1,requestsPerMinute:100,now:()=>now});
    const invalid='invalid-group5-token-0123456789abcdef012345';
    await assert.rejects(sourceLimited.authenticate({authorization:`Bearer ${invalid}`,remoteAddress:'10.0.0.1'}),AuthenticationError);
    await assert.rejects(sourceLimited.authenticate({authorization:`Bearer ${invalid}`,remoteAddress:'10.0.0.1'}),RateLimitError);
    limited=db.raw.prepare("SELECT COUNT(*) AS count FROM auth_audit WHERE outcome='RATE_LIMITED'").get() as unknown as {count:number};
    assert.ok(Number(limited.count)>=2);
  }finally{db.close();}
});

test('audit retention removes old auth and MCP audit rows without deleting current evidence',()=>{
  const db=new SqliteDatabase(':memory:');
  try{
    const store=new AuthenticationStore(db);
    db.raw.prepare('INSERT INTO auth_audit(audit_id,principal_id,credential_id,outcome,reason,created_at) VALUES(?,?,?,?,?,?)')
      .run('old-auth',null,null,'FAILURE','TEST','2025-01-01T00:00:00.000Z');
    db.raw.prepare('INSERT INTO auth_audit(audit_id,principal_id,credential_id,outcome,reason,created_at) VALUES(?,?,?,?,?,?)')
      .run('new-auth',null,null,'FAILURE','TEST','2026-09-18T00:00:00.000Z');
    db.raw.prepare('INSERT INTO mcp_audit(audit_id,request_id,principal_id,tool_name,project_id,success,error_code,created_at,credential_id) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('old-mcp','1','p','probe',null,1,null,'2025-01-01T00:00:00.000Z',null);
    db.raw.prepare('INSERT INTO mcp_audit(audit_id,request_id,principal_id,tool_name,project_id,success,error_code,created_at,credential_id) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('new-mcp','2','p','probe',null,1,null,'2026-09-18T00:00:00.000Z',null);
    const result=store.pruneAudit(30,new Date('2026-09-19T00:00:00Z'));
    assert.deepEqual(result,{authEvents:1,mcpEvents:1});
    assert.equal((db.raw.prepare('SELECT COUNT(*) AS count FROM auth_audit').get() as unknown as {count:number}).count,1);
    assert.equal((db.raw.prepare('SELECT COUNT(*) AS count FROM mcp_audit').get() as unknown as {count:number}).count,1);
  }finally{db.close();}
});

test('MCP audit records the non-secret credential id for authenticated tool activity',async()=>{
  const db=new SqliteDatabase(':memory:');
  try{
    const tools=new McpToolRegistry(new DefaultDenyAuthorizer(),db);
    tools.register({definition:{name:'group5_probe',description:'probe',inputSchema:{type:'object'}},permission:'project:read',handler:async()=>({ok:true})});
    const principal={...principalA,credentialId:'cred-a'};
    await tools.call('group5_probe',{}, {principal,requestId:'g5'});
    const row=db.raw.prepare("SELECT principal_id,credential_id,success FROM mcp_audit WHERE tool_name='group5_probe'").get() as unknown as {principal_id:string;credential_id:string;success:number};
    assert.deepEqual(row,{principal_id:'principal-a',credential_id:'cred-a',success:1});
  }finally{db.close();}
});

test('host control client uses only the configured Unix socket and bounded structured request',async()=>{
  const temp=await tempDir('server-agent-host-client-');
  const socketPath=path.join(temp.path,'host.sock');
  let received='';
  const server=net.createServer((socket)=>{
    socket.on('data',(chunk)=>{received+=String(chunk);});
    socket.on('end',()=>socket.end(JSON.stringify({ok:true,exitCode:0,stdout:'active\n',stderr:''})));
  });
  try{
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,()=>resolve());});
    const result=await requestHostControl(socketPath,'status','demo.service');
    assert.equal(result.stdout,'active\n');
    assert.deepEqual(JSON.parse(received.trim()),{action:'status',serviceName:'demo.service'});
  }finally{
    await new Promise<void>((resolve)=>server.close(()=>resolve()));
    await temp.cleanup();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SqliteDatabase } from '../../src/database/sqlite.js';
import { AuthenticationStore } from '../../src/security/auth-store.js';
import { OAuthService } from '../../src/oauth/oauth-service.js';
import type { OAuthConfig } from '../../src/oauth/config.js';
import { loadOAuthConfig } from '../../src/oauth/config.js';
import { ValidationError } from '../../src/core/errors.js';

const base = 'https://agent.example.com';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const ownerSecret = 'owner-secret-0123456789abcdef0123456789abcdef';

function config(): OAuthConfig {
  return {
    publicBaseUrl: base,
    issuer: base,
    resource: base,
    ownerSecret,
    principal: {
      id: 'chatgpt-oauth',
      kind: 'remote',
      projectScopes: ['project-a'],
      permissions: ['project:read','files:read','git:read'],
    },
    scope: 'mcp:read',
    allowedRedirectOrigins: ['https://chatgpt.com'],
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 2_592_000,
  };
}

function request(method:string,path:string,body='',headers:Record<string,string>={}){
  return {method,path,body,headers,remoteAddress:'127.0.0.1'} as const;
}

test('OAuth config defaults to disabled and enforces explicit read-only project scopes when enabled',()=>{
  assert.equal(loadOAuthConfig({}),null);
  const loaded=loadOAuthConfig({
    SERVER_AGENT_OAUTH_ENABLED:'true',
    SERVER_AGENT_PUBLIC_BASE_URL:base,
    SERVER_AGENT_OAUTH_OWNER_SECRET:ownerSecret,
    SERVER_AGENT_OAUTH_PROJECT_SCOPES:'project-a',
    SERVER_AGENT_OAUTH_PERMISSIONS:'project:read,files:read,git:read',
  });
  assert.equal(loaded?.resource,base);
  assert.deepEqual(loaded?.allowedRedirectOrigins,['https://chatgpt.com']);
  assert.throws(()=>loadOAuthConfig({
    SERVER_AGENT_OAUTH_ENABLED:'true',
    SERVER_AGENT_PUBLIC_BASE_URL:base,
    SERVER_AGENT_OAUTH_OWNER_SECRET:ownerSecret,
    SERVER_AGENT_OAUTH_PROJECT_SCOPES:'*',
    SERVER_AGENT_OAUTH_PERMISSIONS:'project:read',
  }),ValidationError);
  assert.throws(()=>loadOAuthConfig({
    SERVER_AGENT_OAUTH_ENABLED:'true',
    SERVER_AGENT_PUBLIC_BASE_URL:base,
    SERVER_AGENT_OAUTH_OWNER_SECRET:ownerSecret,
    SERVER_AGENT_OAUTH_PROJECT_SCOPES:'project-a',
    SERVER_AGENT_OAUTH_PERMISSIONS:'files:write',
  }),ValidationError);
});

test('OAuth service exposes discovery, DCR, PKCE code exchange, refresh, and bounded ChatGPT redirects',async()=>{
  const db=new SqliteDatabase(':memory:');
  try{
    const authStore=new AuthenticationStore(db);
    const oauth=new OAuthService(db,authStore,config());

    const prm=oauth.handle(request('GET','/.well-known/oauth-protected-resource'));
    assert.equal(prm?.status,200);
    assert.deepEqual(JSON.parse(prm?.body??'{}').authorization_servers,[base]);

    const asm=oauth.handle(request('GET','/.well-known/oauth-authorization-server'));
    const metadata=JSON.parse(asm?.body??'{}');
    assert.equal(metadata.issuer,base);
    assert.equal(metadata.authorization_response_iss_parameter_supported,true);
    assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);
    assert.deepEqual(metadata.scopes_supported,['mcp:read','offline_access']);
    assert.equal(metadata.registration_endpoint,`${base}/oauth/register`);

    const badRegister=oauth.handle(request('POST','/oauth/register',JSON.stringify({
      redirect_uris:['https://evil.example/callback'],
      token_endpoint_auth_method:'none',
    }),{'content-type':'application/json'}));
    assert.equal(badRegister?.status,400);

    const registered=oauth.handle(request('POST','/oauth/register',JSON.stringify({
      redirect_uris:[redirectUri],
      token_endpoint_auth_method:'none',
      grant_types:['authorization_code','refresh_token'],
      response_types:['code'],
      application_type:'web',
      client_name:'ChatGPT',
    }),{'content-type':'application/json'}));
    assert.equal(registered?.status,201);
    const clientId=JSON.parse(registered?.body??'{}').client_id as string;
    assert.match(clientId,/^dcr_/);

    const verifier='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
    const challenge=createHash('sha256').update(verifier,'ascii').digest('base64url');
    const params=new URLSearchParams({
      response_type:'code',
      client_id:clientId,
      redirect_uri:redirectUri,
      state:'state-1',
      code_challenge:challenge,
      code_challenge_method:'S256',
      scope:'mcp:read offline_access',
      resource:base,
    });

    const authorizePage=oauth.handle(request('GET',`/oauth/authorize?${params.toString()}`));
    assert.equal(authorizePage?.status,200);
    assert.match(authorizePage?.body??'',/Authorize Server Agent/);
    assert.equal((authorizePage?.headers['content-security-policy']??'').includes("frame-ancestors 'none'"),true);

    const wrong=new URLSearchParams(params);
    wrong.set('owner_secret','not-the-owner-secret');
    const denied=oauth.handle(request('POST','/oauth/authorize',wrong.toString(),{'content-type':'application/x-www-form-urlencoded'}));
    assert.equal(denied?.status,401);

    const approved=new URLSearchParams(params);
    approved.set('owner_secret',ownerSecret);
    const authorization=oauth.handle(request('POST','/oauth/authorize',approved.toString(),{'content-type':'application/x-www-form-urlencoded'}));
    assert.equal(authorization?.status,303);
    const location=new URL(authorization?.headers.location??'');
    assert.equal(location.origin,'https://chatgpt.com');
    assert.equal(location.searchParams.get('state'),'state-1');
    assert.equal(location.searchParams.get('iss'),base);
    const code=location.searchParams.get('code')??'';
    assert.match(code,/^sa_code_/);

    const tokenBody=new URLSearchParams({
      grant_type:'authorization_code',
      code,
      client_id:clientId,
      redirect_uri:redirectUri,
      code_verifier:verifier,
      resource:base,
    });
    const tokenResponse=oauth.handle(request('POST','/oauth/token',tokenBody.toString(),{'content-type':'application/x-www-form-urlencoded'}));
    assert.equal(tokenResponse?.status,200);
    const tokens=JSON.parse(tokenResponse?.body??'{}') as {access_token:string;refresh_token:string;scope:string;expires_in:number};
    assert.match(tokens.access_token,/^sa_oauth_/);
    assert.match(tokens.refresh_token,/^sa_refresh_/);
    assert.equal(tokens.scope,'mcp:read offline_access');
    assert.equal(tokens.expires_in,3600);


    const noOfflineParams=new URLSearchParams(params);
    noOfflineParams.set('scope','mcp:read');
    noOfflineParams.set('state','state-no-offline');
    const noOfflineApproved=new URLSearchParams(noOfflineParams);
    noOfflineApproved.set('owner_secret',ownerSecret);
    const noOfflineAuthorization=oauth.handle(request('POST','/oauth/authorize',noOfflineApproved.toString(),{'content-type':'application/x-www-form-urlencoded'}));
    assert.equal(noOfflineAuthorization?.status,303);
    const noOfflineLocation=new URL(noOfflineAuthorization?.headers.location??'');
    const noOfflineCode=noOfflineLocation.searchParams.get('code')??'';
    const noOfflineTokenBody=new URLSearchParams({
      grant_type:'authorization_code',
      code:noOfflineCode,
      client_id:clientId,
      redirect_uri:redirectUri,
      code_verifier:verifier,
      resource:base,
    });
    const noOfflineTokenResponse=oauth.handle(request('POST','/oauth/token',noOfflineTokenBody.toString(),{'content-type':'application/x-www-form-urlencoded'}));
    assert.equal(noOfflineTokenResponse?.status,200);
    const noOfflineTokens=JSON.parse(noOfflineTokenResponse?.body??'{}') as {access_token:string;refresh_token?:string;scope:string};
    assert.equal(noOfflineTokens.scope,'mcp:read');
    assert.equal(noOfflineTokens.refresh_token,undefined);

    const principal=authStore.authenticate(tokens.access_token);
    assert.equal(principal.id,'chatgpt-oauth');
    assert.deepEqual(principal.projectScopes,['project-a']);
    assert.deepEqual(principal.permissions,['project:read','files:read','git:read']);

    const replay=oauth.handle(request('POST','/oauth/token',tokenBody.toString(),{'content-type':'application/x-www-form-urlencoded'}));
    assert.equal(replay?.status,400);
    assert.equal(JSON.parse(replay?.body??'{}').error,'invalid_grant');

    const refreshBody=new URLSearchParams({
      grant_type:'refresh_token',
      refresh_token:tokens.refresh_token,
      client_id:clientId,
      resource:base,
    });
    const refreshed=oauth.handle(request('POST','/oauth/token',refreshBody.toString(),{'content-type':'application/x-www-form-urlencoded'}));
    assert.equal(refreshed?.status,200);
    const refreshedTokens=JSON.parse(refreshed?.body??'{}') as {access_token:string;refresh_token:string};
    assert.notEqual(refreshedTokens.access_token,tokens.access_token);
    assert.notEqual(refreshedTokens.refresh_token,tokens.refresh_token);

    const refreshReplay=oauth.handle(request('POST','/oauth/token',refreshBody.toString(),{'content-type':'application/x-www-form-urlencoded'}));
    assert.equal(refreshReplay?.status,400);
  }finally{
    db.close();
  }
});

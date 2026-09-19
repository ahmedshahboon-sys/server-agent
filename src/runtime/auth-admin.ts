import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/config.js';
import { SqliteDatabase } from '../database/sqlite.js';
import type { Principal, ProjectPermission } from '../core/types.js';
import { ValidationError } from '../core/errors.js';
import { PROJECT_PERMISSION_SET } from '../security/permissions.js';
import { AuthenticationStore } from '../security/auth-store.js';
import { redactError } from '../security/redaction.js';

function option(args: readonly string[], name: string, required = false): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    if (required) throw new ValidationError(`${name} is required`);
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new ValidationError(`${name} requires a value`);
  return value;
}

function csv(value: string | undefined, name: string): readonly string[] {
  if (value === undefined || value.trim() === '') throw new ValidationError(`${name} is required`);
  const values = [...new Set(value.split(',').map((item)=>item.trim()).filter(Boolean))];
  if (values.length === 0) throw new ValidationError(`${name} is required`);
  return values;
}

function principalFromArgs(args: readonly string[]): Principal {
  const id = option(args,'--principal',true) ?? '';
  if (!/^[A-Za-z0-9._:-]{2,128}$/.test(id)) throw new ValidationError('Principal id is invalid');
  const projectScopes = csv(option(args,'--scopes',true),'--scopes');
  for (const scope of projectScopes) if (scope !== '*' && !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(scope)) throw new ValidationError('Invalid project scope');
  const rawPermissions = csv(option(args,'--permissions',true),'--permissions');
  for (const permission of rawPermissions) if (!PROJECT_PERMISSION_SET.has(permission as ProjectPermission)) throw new ValidationError(`Unknown permission ${permission}`);
  return { id, kind:'remote', projectScopes, permissions: rawPermissions as readonly ProjectPermission[] };
}

function newBearerToken(): string {
  return `sa_${randomBytes(32).toString('base64url')}`;
}

function usage(): never {
  process.stderr.write([
    'Usage:',
    '  auth-admin list [--principal ID]',
    '  auth-admin create --principal ID --credential ID --scopes a,b --permissions p,q [--expires-at ISO]',
    '  auth-admin rotate --credential OLD --new-credential NEW [--expires-at ISO]',
    '  auth-admin revoke --credential ID',
    '  auth-admin enable-principal --principal ID',
    '  auth-admin disable-principal --principal ID',
    '',
  ].join('\n'));
  process.exitCode=64;
  throw new Error('USAGE');
}

export async function runAuthAdmin(args: readonly string[] = process.argv.slice(2), env:NodeJS.ProcessEnv=process.env):Promise<void>{
  const command=args[0];
  if(command===undefined) usage();
  const config=loadConfig(env);
  const db=new SqliteDatabase(config.dbPath);
  const store=new AuthenticationStore(db);
  try{
    if(command==='list'){
      const principal=option(args,'--principal');
      process.stdout.write(`${JSON.stringify(store.listCredentials(principal),null,2)}\n`);
      return;
    }
    if(command==='create'){
      const principal=principalFromArgs(args);
      const credentialId=option(args,'--credential',true) ?? '';
      const token=newBearerToken();
      const created=store.createCredential(principal,credentialId,token,option(args,'--expires-at'));
      process.stdout.write(`${JSON.stringify({credential:created,bearerToken:token,note:'Bearer token is shown once; store it outside Git and rotate if lost.'},null,2)}\n`);
      return;
    }
    if(command==='rotate'){
      const oldCredential=option(args,'--credential',true) ?? '';
      const newCredential=option(args,'--new-credential',true) ?? '';
      const token=newBearerToken();
      const created=store.rotateCredential(oldCredential,newCredential,token,option(args,'--expires-at'));
      process.stdout.write(`${JSON.stringify({credential:created,bearerToken:token,note:'Old credential was revoked. New bearer token is shown once.'},null,2)}\n`);
      return;
    }
    if(command==='revoke'){
      process.stdout.write(`${JSON.stringify(store.revokeCredential(option(args,'--credential',true) ?? ''),null,2)}\n`);
      return;
    }
    if(command==='enable-principal'||command==='disable-principal'){
      store.setPrincipalEnabled(option(args,'--principal',true) ?? '',command==='enable-principal');
      process.stdout.write(`${JSON.stringify({ok:true,enabled:command==='enable-principal'})}\n`);
      return;
    }
    usage();
  } finally {
    db.close();
  }
}

async function main():Promise<void>{
  try{await runAuthAdmin();}
  catch(error){
    if(error instanceof Error && error.message==='USAGE') return;
    process.stderr.write(`${JSON.stringify({level:'error',message:'Auth admin command failed',error:redactError(error)})}\n`);
    process.exitCode=1;
  }
}

const entry=process.argv[1];
if(entry!==undefined&&path.resolve(entry)===fileURLToPath(import.meta.url)) void main();

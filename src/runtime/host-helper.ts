import { chmod, lstat, mkdir, readFile, unlink } from 'node:fs/promises';
import net, { type Server, type Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeArgv } from '../commands/process-executor.js';
import { ValidationError } from '../core/errors.js';
import { redactError } from '../security/redaction.js';

const DEFAULT_SOCKET='/run/server-agent-host/hostctl.sock';
const DEFAULT_ALLOWLIST='/etc/server-agent/allowed-services';
const MAX_REQUEST_BYTES=4096;
const MAX_OUTPUT_BYTES=262_144;

interface RequestShape { readonly action:'status'|'restart'|'logs'; readonly serviceName:string; readonly lines?:number; }

function stringEnv(env:NodeJS.ProcessEnv,key:string,fallback:string):string{
  const value=env[key]?.trim()||fallback;
  if(!path.isAbsolute(value)||value.includes('\0'))throw new ValidationError(`${key} must be an absolute path`);
  return value;
}

async function allowedServices(filename:string):Promise<ReadonlySet<string>>{
  const content=await readFile(filename,'utf8');
  const services=new Set<string>();
  for(const raw of content.split(/\r?\n/)){
    const line=raw.trim();
    if(line===''||line.startsWith('#'))continue;
    if(!/^[A-Za-z0-9@_.:-]{1,128}\.service$/.test(line))throw new ValidationError('Host service allowlist contains an invalid unit');
    services.add(line);
    if(services.size>256)throw new ValidationError('Host service allowlist exceeds 256 units');
  }
  return services;
}

function parseRequest(input:string):RequestShape{
  let parsed:unknown;
  try{parsed=JSON.parse(input) as unknown;}catch{throw new ValidationError('Host helper request is invalid JSON');}
  if(parsed===null||typeof parsed!=='object'||Array.isArray(parsed))throw new ValidationError('Host helper request must be an object');
  const row=parsed as Record<string,unknown>;
  for(const key of Object.keys(row))if(!['action','serviceName','lines'].includes(key))throw new ValidationError(`Host helper request contains unknown field ${key}`);
  const action=row['action'];
  const serviceName=row['serviceName'];
  if(!['status','restart','logs'].includes(String(action)))throw new ValidationError('Host helper action is invalid');
  if(typeof serviceName!=='string'||!/^[A-Za-z0-9@_.:-]{1,128}\.service$/.test(serviceName))throw new ValidationError('Host helper service name is invalid');
  const lines=row['lines'];
  if(action==='logs'){
    if(typeof lines!=='number'||!Number.isInteger(lines)||lines<1||lines>2000)throw new ValidationError('Host helper log line count must be 1-2000');
    return {action:'logs',serviceName,lines};
  }
  if(lines!==undefined)throw new ValidationError('Host helper lines is valid only for logs');
  return {action:action as 'status'|'restart',serviceName};
}

async function execute(request:RequestShape,allowlistFile:string){
  const allowed=await allowedServices(allowlistFile);
  if(!allowed.has(request.serviceName))throw new ValidationError('Requested service is not present in the host allowlist');
  const argv=request.action==='status'
    ? ['/usr/bin/systemctl','is-active',request.serviceName]
    : request.action==='restart'
      ? ['/usr/bin/systemctl','restart',request.serviceName]
      : ['/usr/bin/journalctl','--unit',request.serviceName,'--no-pager','--output=short-iso','--lines',String(request.lines)];
  const result=await executeArgv(argv,{cwd:'/',env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C.UTF-8'},timeoutMs:request.action==='restart'?30_000:10_000,maxOutputBytes:MAX_OUTPUT_BYTES});
  return {ok:result.exitCode===0,exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr,stdoutTruncated:result.stdoutTruncated,stderrTruncated:result.stderrTruncated};
}

async function handleSocket(socket:Socket,allowlistFile:string):Promise<void>{
  const chunks:Buffer[]=[];let bytes=0;
  try{
    for await(const chunkValue of socket){
      const chunk=Buffer.isBuffer(chunkValue)?chunkValue:Buffer.from(chunkValue);
      bytes+=chunk.length;
      if(bytes>MAX_REQUEST_BYTES)throw new ValidationError('Host helper request exceeded the allowed size');
      chunks.push(chunk);
    }
    const raw=Buffer.concat(chunks).toString('utf8').trim();
    const request=parseRequest(raw);
    const result=await execute(request,allowlistFile);
    socket.end(JSON.stringify(result));
  }catch(error){
    socket.end(JSON.stringify({ok:false,exitCode:77,stdout:'',stderr:'Host helper request denied',error:redactError(error)}));
  }
}

async function prepareSocket(socketPath:string):Promise<void>{
  await mkdir(path.dirname(socketPath),{recursive:true,mode:0o750});
  try{
    const stat=await lstat(socketPath);
    if(!stat.isSocket())throw new ValidationError('Refusing to replace non-socket host helper path');
    await unlink(socketPath);
  }catch(error){
    const code=(error as NodeJS.ErrnoException).code;
    if(code!=='ENOENT')throw error;
  }
}

function close(server:Server):Promise<void>{return new Promise((resolve)=>server.close(()=>resolve()));}

export async function runHostHelper(env:NodeJS.ProcessEnv=process.env):Promise<void>{
  if(process.getuid!==undefined&&process.getuid()!==0)throw new ValidationError('Host helper must run as root');
  const socketPath=stringEnv(env,'SERVER_AGENT_HOST_HELPER_SOCKET',DEFAULT_SOCKET);
  const allowlistFile=stringEnv(env,'SERVER_AGENT_HOST_ALLOWLIST',DEFAULT_ALLOWLIST);
  await prepareSocket(socketPath);
  await allowedServices(allowlistFile);
  const server=net.createServer((socket)=>{void handleSocket(socket,allowlistFile);});
  server.maxConnections=16;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,()=>resolve());});
  await chmod(socketPath,0o660);
  const shutdown=async()=>{await close(server);try{await unlink(socketPath);}catch{}};
  process.once('SIGTERM',()=>{void shutdown();});
  process.once('SIGINT',()=>{void shutdown();});
}

async function main():Promise<void>{
  try{await runHostHelper();}
  catch(error){process.stderr.write(`${JSON.stringify({level:'error',message:'Server Agent host helper failed',error:redactError(error)})}\n`);process.exitCode=1;}
}

const entry=process.argv[1];
if(entry!==undefined&&path.resolve(entry)===fileURLToPath(import.meta.url))void main();

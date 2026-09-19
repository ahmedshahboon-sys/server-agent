import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const protocolVersion = '2026-07-28';
const token = 'phase5-runtime-smoke-token-0123456789abcdef';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const meta = { 'io.modelcontextprotocol/protocolVersion': protocolVersion, 'io.modelcontextprotocol/clientCapabilities': {} };

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') { server.close(); reject(new Error('Unable to allocate loopback test port')); return; }
      const port = address.port;
      server.close((error) => error === undefined ? resolve(port) : reject(error));
    });
  });
}

async function rpc(port, id, method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'mcp-protocol-version': protocolVersion,
      'mcp-method': method,
      'content-length': Buffer.byteLength(body),
    } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function getJson(port, route) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: route, method: 'GET' }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, body, json: JSON.parse(body) });
      });
    });
    request.once('error', reject);
    request.end();
  });
}

async function rssBytes(pid) {
  if (process.platform !== 'linux') return null;
  const status = await readFile(`/proc/${pid}/status`, 'utf8');
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  return match === null ? null : Number(match[1]) * 1024;
}

const temp = await mkdtemp(path.join(os.tmpdir(), 'server-agent-runtime-sanity-'));
const port = await freePort();
let stdout = '';
let stderr = '';
const child = spawn(process.execPath, ['dist/runtime/server-agent.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SERVER_AGENT_DATA_DIR: temp,
    SERVER_AGENT_DB_PATH: path.join(temp, 'state.sqlite'),
    SERVER_AGENT_MCP_HOST: '127.0.0.1',
    SERVER_AGENT_MCP_PORT: String(port),
    SERVER_AGENT_MCP_PATH: '/mcp',
    SERVER_AGENT_MCP_ALLOW_PUBLIC_BIND: 'false',
    SERVER_AGENT_MCP_PROJECT_SCOPES: '*',
    SERVER_AGENT_MCP_PERMISSIONS: 'project:read,project:update:state,project:archive,commands:run,recovery:run',
    SERVER_AGENT_MCP_BEARER_TOKEN: token,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => { stdout += String(chunk); });
child.stderr.on('data', (chunk) => { stderr += String(chunk); });

try {
  let discovery = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`runtime exited before readiness: ${stderr.slice(0, 1000)}`);
    try { discovery = await rpc(port, 1, 'server/discover', { _meta: meta }); break; } catch { await sleep(100); }
  }
  if (discovery === null) throw new Error(`runtime did not become ready: ${stderr.slice(0, 1000)}`);
  if (discovery.status !== 200) throw new Error(`server/discover returned HTTP ${discovery.status}: ${discovery.body.slice(0, 1000)}`);
  const parsedDiscovery = JSON.parse(discovery.body);
  if (!parsedDiscovery.result?.supportedVersions?.includes(protocolVersion)) throw new Error('runtime discovery did not advertise the expected MCP protocol');

  const healthz = await getJson(port, '/healthz');
  if (healthz.status !== 200 || healthz.json?.live !== true) throw new Error(`/healthz failed: HTTP ${healthz.status} ${healthz.body.slice(0, 500)}`);
  const readyz = await getJson(port, '/readyz');
  if (readyz.status !== 200 || readyz.json?.ready !== true) throw new Error(`/readyz failed: HTTP ${readyz.status} ${readyz.body.slice(0, 500)}`);

  const listed = await rpc(port, 2, 'tools/list', { _meta: meta });
  if (listed.status !== 200) throw new Error(`tools/list returned HTTP ${listed.status}: ${listed.body.slice(0, 1000)}`);
  const names = new Set((JSON.parse(listed.body).result?.tools ?? []).map((tool) => tool.name));
  for (const expected of ['list_projects','enable_project','remove_project','run_command','job_status','recovery_assess','system_snapshot']) {
    if (!names.has(expected)) throw new Error(`runtime tools/list is missing ${expected}`);
  }
  if (names.has('register_project')) throw new Error('runtime tools/list exposed register_project without project:register');

  const rss = await rssBytes(child.pid);
  if (rss !== null && rss > 256 * 1024 * 1024) throw new Error(`idle runtime RSS ${rss} exceeds 256 MiB sanity ceiling`);
  if (!stdout.includes('Server Agent MCP listening')) throw new Error('runtime did not emit its safe readiness log');
  console.log(`Runtime sanity passed (discover=200, healthz=200, readyz=200, tools=${names.size}${rss === null ? '' : `, rssMiB=${(rss / 1024 / 1024).toFixed(1)}`}).`);
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt += 1) await sleep(100);
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(temp, { recursive: true, force: true });
}

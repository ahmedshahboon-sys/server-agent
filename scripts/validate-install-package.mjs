import { readFileSync, existsSync } from 'node:fs';

const required = [
  'install/install.sh',
  'install/uninstall.sh',
  'install/server-agent.env.example',
  'install/systemd/server-agent.service.template',
  'docs/installation.md',
  'docs/cloudflare-remote-mcp.md',
  'docs/operations.md',
  'docs/final-validation.md',
];
const errors = [];
for (const file of required) if (!existsSync(file)) errors.push(`missing required install artifact: ${file}`);

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
if (packageJson.version !== '0.5.0') errors.push('package version must be 0.5.0 for Phase 5');
if (packageJson.scripts?.start !== 'node dist/runtime/server-agent.js') errors.push('package start script must launch the hardened runtime entrypoint');
if (packageJson.dependencies !== undefined && Object.keys(packageJson.dependencies).length > 0) errors.push('runtime dependencies are not expected in the lightweight Phase 5 package');

const envExample = readFileSync('install/server-agent.env.example', 'utf8');
if (!envExample.includes('SERVER_AGENT_MCP_HOST=127.0.0.1')) errors.push('install environment must bind MCP to loopback by default');
if (!envExample.includes('SERVER_AGENT_MCP_ALLOW_PUBLIC_BIND=false')) errors.push('public MCP bind must be disabled by default');
if (!envExample.includes('SERVER_AGENT_MAX_CONCURRENT_JOBS=1')) errors.push('heavy job concurrency must default to one');
if (!envExample.includes('SERVER_AGENT_MCP_BEARER_TOKEN=CHANGE_ME_')) errors.push('install environment must contain only a bearer-token placeholder');

const unit = readFileSync('install/systemd/server-agent.service.template', 'utf8');
for (const directive of ['User=@@USER@@','Group=@@GROUP@@','EnvironmentFile=@@ENV_FILE@@','NoNewPrivileges=true','ProtectSystem=full','CapabilityBoundingSet=','MemoryMax=2G']) {
  if (!unit.includes(directive)) errors.push(`systemd template missing hardening directive: ${directive}`);
}
if (/^User=root$/m.test(unit)) errors.push('systemd template must never run as root');

const installer = readFileSync('install/install.sh', 'utf8');
const uninstaller = readFileSync('install/uninstall.sh', 'utf8');
for (const forbidden of ['nginx','ufw','iptables','firewalld','cloudflared','docker compose','docker-compose']) {
  if (installer.toLowerCase().includes(forbidden)) errors.push(`installer must not mutate unrelated infrastructure: ${forbidden}`);
}
if (!installer.includes('ENABLE_SERVICE=0') || !installer.includes('--enable')) errors.push('installer must default to prepared-but-not-started state');
if (/rm\s+-rf\b/.test(installer) || /rm\s+-rf\b/.test(uninstaller)) errors.push('install helpers must not recursively delete trees');
if (!uninstaller.includes('Preserved intentionally')) errors.push('uninstall helper must explicitly preserve state and source data');

if (errors.length > 0) {
  console.error('Install package validation failed:');
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}
console.log(`Install package validation passed (${required.length} required artifacts checked).`);

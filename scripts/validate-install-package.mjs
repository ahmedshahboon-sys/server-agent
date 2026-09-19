import { readFileSync, existsSync } from 'node:fs';

const required = [
  'install/install.sh',
  'install/uninstall.sh',
  'install/server-agent.env.example',
  'install/systemd/server-agent.service.template',
  'install/systemd/server-agent-host-helper.service.template',
  'install/host/allowed-services.example',
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
if (!envExample.includes('SERVER_AGENT_AUTH_ATTEMPTS_PER_MINUTE=30')) errors.push('authentication attempt limiting must be configured');
if (!envExample.includes('SERVER_AGENT_AUTH_REQUESTS_PER_MINUTE=120')) errors.push('authenticated request limiting must be configured');
if (!envExample.includes('SERVER_AGENT_AUDIT_RETENTION_DAYS=30')) errors.push('audit retention must be configured');
if (!envExample.includes('SERVER_AGENT_HOST_HELPER_SOCKET=/run/server-agent-host/hostctl.sock')) errors.push('production environment must route host operations through the Unix helper');
if (!envExample.includes('SERVER_AGENT_MCP_CREDENTIAL_ID=bootstrap-chatgpt')) errors.push('bootstrap credential must have a non-secret id');
if (!envExample.includes('SERVER_AGENT_MCP_BEARER_TOKEN=CHANGE_ME_')) errors.push('install environment must contain only a bearer-token placeholder');

const unit = readFileSync('install/systemd/server-agent.service.template', 'utf8');
for (const directive of ['User=@@USER@@','Group=@@GROUP@@','EnvironmentFile=@@ENV_FILE@@','NoNewPrivileges=true','ProtectSystem=full','ProtectHome=true','UMask=0077','CapabilityBoundingSet=','MemoryMax=2G']) {
  if (!unit.includes(directive)) errors.push(`systemd template missing hardening directive: ${directive}`);
}
if (/^User=root$/m.test(unit)) errors.push('main systemd template must never run as root');

const helperUnit = readFileSync('install/systemd/server-agent-host-helper.service.template', 'utf8');
for (const directive of ['User=root','Group=@@GROUP@@','NoNewPrivileges=true','ProtectSystem=strict','ProtectHome=true','CapabilityBoundingSet=','RestrictAddressFamilies=AF_UNIX','RuntimeDirectory=server-agent-host']) {
  if (!helperUnit.includes(directive)) errors.push(`host helper unit missing hardening directive: ${directive}`);
}
if (/AF_INET/.test(helperUnit)) errors.push('host helper must not receive IP networking');

const installer = readFileSync('install/install.sh', 'utf8');
const uninstaller = readFileSync('install/uninstall.sh', 'utf8');
for (const forbidden of ['nginx','ufw','iptables','firewalld','cloudflared','docker compose','docker-compose']) {
  if (installer.toLowerCase().includes(forbidden)) errors.push(`installer must not mutate unrelated infrastructure: ${forbidden}`);
}
if (!installer.includes('ENABLE_SERVICE=0') || !installer.includes('--enable')) errors.push('installer must default to prepared-but-not-started state');
if (/rm\s+-rf\b/.test(installer) || /rm\s+-rf\b/.test(uninstaller)) errors.push('install helpers must not recursively delete trees');
if (!uninstaller.includes('Preserved intentionally')) errors.push('uninstall helper must explicitly preserve state and source data');
if (!installer.includes('allowed-services') || !installer.includes('server-agent-host-helper.service')) errors.push('installer must provision the empty host allowlist and isolated helper unit');
if (/usermod\b[^\n]*systemd-journal/i.test(installer)) errors.push('installer must not grant broad systemd-journal group membership');
if (/sudoers|NOPASSWD/i.test(installer)) errors.push('installer must not install a broad sudo policy');
if (!installer.includes('Refusing installation: Server Agent runtime/source contains paths owned by service user')) errors.push('installer must verify service user cannot own runtime source');

if (errors.length > 0) {
  console.error('Install package validation failed:');
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}
console.log(`Install package validation passed (${required.length} required artifacts checked).`);

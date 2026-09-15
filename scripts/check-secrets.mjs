import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const forbiddenPaths = [
  /(^|\/)\.env($|\.)/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)(id_rsa|id_ed25519)$/i,
  /(^|\/)(credentials|secrets?)([._-]|$)/i,
];
const forbiddenContent = [
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/,
  /\b(?:sk-proj|ghp|github_pat)_[A-Za-z0-9_-]{20,}\b/,
  /\b(?:CLOUDFLARE_API_TOKEN|SSH_PRIVATE_KEY|PRODUCTION_DB_URL)\s*=\s*\S+/,
];

const errors = [];
for (const file of tracked) {
  if (file === '.env.example') continue;
  if (forbiddenPaths.some((pattern) => pattern.test(file))) errors.push(`forbidden sensitive path: ${file}`);
  if (file.startsWith('tests/')) continue;
  let content;
  try { content = readFileSync(file, 'utf8'); } catch { continue; }
  for (const pattern of forbiddenContent) {
    if (pattern.test(content)) errors.push(`possible secret material in ${file}: ${pattern}`);
  }
}

if (errors.length > 0) {
  console.error('Secret scan failed:');
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}
console.log(`Secret scan passed (${tracked.length} tracked files checked).`);

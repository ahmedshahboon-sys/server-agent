import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const roots = ['src', 'tests', 'scripts'];
const extensions = new Set(['.ts', '.mjs']);
const problems = [];

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (extensions.has(path.extname(entry.name))) check(full);
  }
}

function check(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (/\s+$/.test(line)) problems.push(`${file}:${index + 1}: trailing whitespace`);
    if (line.includes('\t')) problems.push(`${file}:${index + 1}: tab character`);
  });
  if (text.includes('console.log(') && !file.startsWith('scripts/')) problems.push(`${file}: console.log is not allowed in source/tests`);
  if (file.endsWith('.ts') && /\bas any\b/.test(text)) problems.push(`${file}: unsafe type assertion is not allowed`);
}

roots.forEach(walk);
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('Lint checks passed.');

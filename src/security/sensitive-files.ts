import path from 'node:path';
import { SensitiveFileError } from '../core/errors.js';

const DENIED_EXACT = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  '.dockercfg',
  '.yarnrc.yml',
  'auth.json',
  'kubeconfig',
  'id_rsa',
  'id_ed25519',
  'authorized_keys',
]);

const DENIED_DIRECTORIES = new Set([
  '.aws',
  '.azure',
  '.docker',
  '.gnupg',
  '.kube',
  '.ssh',
  '.terraform',
]);

const DENIED_PATTERNS = [
  /^\.env\..+/i,
  /\.(?:pem|key|p12|pfx)$/i,
  /\.tfstate(?:\.backup)?$/i,
  /(?:^|[-_.])kubeconfig(?:[-_.]|$)/i,
  /^credentials(?:\.|-|_|$)/i,
  /^secrets?(?:\.|-|_|$)/i,
  /^service[-_.]?account(?:[-_.].*)?\.json$/i,
  /(?:^|[-_.])private[-_.]?key(?:[-_.]|$)/i,
  /(?:^|[-_.])tokens?(?:[-_.]|$)/i,
];

export class SensitiveFilePolicy {
  public isSensitive(relativePath: string): boolean {
    const parts = relativePath.split(/[\\/]+/).filter(Boolean);
    return parts.some((part) => {
      const basename = path.basename(part).toLowerCase();
      return DENIED_DIRECTORIES.has(basename) || DENIED_EXACT.has(basename) || DENIED_PATTERNS.some((pattern) => pattern.test(basename));
    });
  }

  public assertReadable(relativePath: string): void {
    if (this.isSensitive(relativePath)) throw new SensitiveFileError();
  }

  public assertWritable(relativePath: string): void {
    if (this.isSensitive(relativePath)) throw new SensitiveFileError('Sensitive file writes are denied by default');
  }
}

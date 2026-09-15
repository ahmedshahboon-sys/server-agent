const SENSITIVE_KEY = /(?:pass(?:word)?|secret|token|api[_-]?key|private[_-]?key|credential|authorization|cookie|session|dsn|database[_-]?url)/i;
const PRIVATE_KEY_BLOCK = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const ASSIGNMENT = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)\s*=\s*([^\s"']+)/gi;
const AUTH_URL = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;

export const REDACTED = '[REDACTED]';

export function redactString(input: string): string {
  return input
    .replace(PRIVATE_KEY_BLOCK, REDACTED)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(ASSIGNMENT, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(AUTH_URL, (_match, scheme: string) => `${scheme}${REDACTED}@`);
}

export function redactValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === 'string') return redactString(value) as T;
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return REDACTED as T;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen)) as T;
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(nested, seen);
  }
  return output as T;
}

import { AsyncLocalStorage } from 'node:async_hooks';
import { ValidationError } from '../core/errors.js';

const storage = new AsyncLocalStorage<string>();

export function currentIdempotencyKey(): string | undefined { return storage.getStore(); }

export async function withIdempotencyKey<T>(key: string | undefined, run: () => Promise<T>): Promise<T> {
  if (key === undefined) return run();
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(key)) throw new ValidationError('Invalid idempotency key');
  return storage.run(key, run);
}

import { AuthenticationError, AuthorizationError, ServerAgentError, ValidationError } from '../core/errors.js';
import { redactString, redactValue } from '../security/redaction.js';

export interface SafeRemoteError {
  readonly code: number;
  readonly message: string;
  readonly data: Readonly<Record<string, unknown>>;
}

function bounded(message: string): string { return redactString(message).slice(0, 1000); }

export function safeRemoteError(error: unknown): SafeRemoteError {
  if (error instanceof AuthenticationError) return { code: -32001, message: 'Authentication required', data: { errorCode: error.code } };
  if (error instanceof AuthorizationError) return { code: -32003, message: 'Access denied', data: { errorCode: error.code } };
  if (error instanceof ValidationError) return { code: -32602, message: bounded(error.message), data: { errorCode: error.code } };
  if (error instanceof ServerAgentError) return { code: -32000, message: bounded(error.message), data: redactValue({ errorCode: error.code }) };
  return { code: -32603, message: 'Internal error', data: { errorCode: 'INTERNAL_ERROR' } };
}

export function safeRemoteValue<T>(value: T): T { return redactValue(value); }

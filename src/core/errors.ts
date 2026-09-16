export class ServerAgentError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends ServerAgentError {
  public constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, 'VALIDATION_ERROR', details);
  }
}

export class AuthorizationError extends ServerAgentError {
  public constructor(message = 'Access denied') { super(message, 'AUTHORIZATION_DENIED'); }
}

export class AuthenticationError extends ServerAgentError {
  public constructor(message = 'Authentication required') { super(message, 'AUTHENTICATION_REQUIRED'); }
}

export class SandboxViolationError extends ServerAgentError {
  public constructor(message: string) { super(message, 'SANDBOX_VIOLATION'); }
}

export class SensitiveFileError extends ServerAgentError {
  public constructor(message = 'Sensitive file access is denied') { super(message, 'SENSITIVE_FILE_DENIED'); }
}

export class CommandDeniedError extends ServerAgentError {
  public constructor(message = 'Command is not allowed') { super(message, 'COMMAND_DENIED'); }
}

export class CommandTimeoutError extends ServerAgentError {
  public constructor(message = 'Command timed out') { super(message, 'COMMAND_TIMEOUT'); }
}

export class AttemptLimitError extends ServerAgentError {
  public constructor(message = 'Attempt limit reached') { super(message, 'ATTEMPT_LIMIT_REACHED'); }
}

export class ConflictError extends ServerAgentError {
  public constructor(message: string) { super(message, 'CONFLICT'); }
}

export class DestructiveOperationError extends ServerAgentError {
  public constructor(message = 'Destructive operation is blocked') { super(message, 'DESTRUCTIVE_OPERATION_BLOCKED'); }
}

export class HealthCheckError extends ServerAgentError {
  public constructor(message = 'Health check failed') { super(message, 'HEALTH_CHECK_FAILED'); }
}

export class DatabaseTimeoutError extends ServerAgentError {
  public constructor(message = 'Database operation timed out') { super(message, 'DATABASE_TIMEOUT'); }
}

export class RecoveryError extends ServerAgentError {
  public constructor(message: string, details?: Readonly<Record<string, unknown>>) { super(message, 'RECOVERY_ERROR', details); }
}

export class RollbackBlockedError extends ServerAgentError {
  public constructor(message = 'Rollback is blocked by safety checks') { super(message, 'ROLLBACK_BLOCKED'); }
}

export class ProtocolError extends ServerAgentError {
  public constructor(message: string, code = 'MCP_PROTOCOL_ERROR') { super(message, code); }
}

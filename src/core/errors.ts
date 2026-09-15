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
  public constructor(message = 'Access denied') {
    super(message, 'AUTHORIZATION_DENIED');
  }
}

export class SandboxViolationError extends ServerAgentError {
  public constructor(message: string) {
    super(message, 'SANDBOX_VIOLATION');
  }
}

export class SensitiveFileError extends ServerAgentError {
  public constructor(message = 'Sensitive file access is denied') {
    super(message, 'SENSITIVE_FILE_DENIED');
  }
}

# Architecture

Server Agent is intentionally split so transport, project operations, safety policy, and persistence can evolve independently.

## Phase 1 boundaries

- `core/`: shared types, interfaces, errors, clock abstraction.
- `config/`: environment-driven non-secret configuration.
- `database/`: SQLite bootstrap and schema migrations for Agent-owned state.
- `projects/`: project registry and project configuration validation.
- `security/`: authorization, filesystem sandbox, sensitive-file policy, secret redaction.
- `logging/`: bounded structured-log foundation with redaction before sink output.

Future phases add files/Git/commands/tasks/jobs/local-CI, then database/deployment/health, then recovery/rollback/MCP transport. MCP will call service interfaces rather than owning business logic.

## Project isolation

Each registered project has an absolute root. File operations in future tools must obtain a project-scoped sandbox and resolve paths through canonical filesystem paths. A project identifier is also checked by the authorization layer, so filesystem scope and logical authorization are independent controls.

## Persistence

SQLite is Agent-owned state. Credentials are not stored in SQLite. Project records contain environment/secret references only.

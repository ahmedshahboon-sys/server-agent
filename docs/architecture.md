# Architecture

Server Agent is intentionally split so transport, project operations, safety policy, and persistence can evolve independently.

## Current boundaries through Phase 2

- `core/`: shared types, interfaces, errors, clock abstraction.
- `config/`: environment-driven non-secret configuration and bounded execution defaults.
- `database/`: SQLite bootstrap and Agent-owned schema migrations.
- `projects/`: project registry and project configuration validation.
- `security/`: authorization, filesystem sandbox, sensitive-file policy, secret/error redaction.
- `logging/`: structured log foundation with redaction before sink output.
- `files/`: project-scoped read/list/search/write/edit/delete operations using the sandbox.
- `commands/`: argv-only process execution, allowlisted project commands, timeout/output/cancellation controls.
- `git/`: fixed Git status/diff/log/branch/commit operations without reset/clean/force behavior.
- `jobs/`: durable process metadata and restart reconciliation.
- `tasks/`: persistent task state, checkpoints, pause/resume/cancel, crash-state recovery marking.
- `validation/`: per-project Local CI pipeline and bounded validation attempts.
- `idempotency/`: persistent operation-key foundations for repeat-safe workflows.

Database/deployment/health arrive in Phase 3. Full recovery/rollback and MCP transport arrive in Phase 4. MCP will call these services rather than own business logic.

## Project isolation

Each registered project has an absolute root. File operations resolve paths through canonical filesystem paths. Authorization checks caller project scope and tool permission, while each project also declares which capabilities are enabled. Filesystem scope, caller authorization, and project capability are separate controls.

## Persistence

SQLite stores Agent-owned project metadata, tasks, checkpoints, jobs, validation history, and idempotency records. Credentials are not stored in SQLite. Project records contain environment/secret references only.

## Process model

Server Agent remains designed for one lightweight main process. Jobs are child processes created only on demand. Concurrency is bounded, output is bounded, and commands are not passed through a shell.

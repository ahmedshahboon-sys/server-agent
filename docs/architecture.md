# Architecture

Server Agent is split so transport, project operations, safety policy, persistence, and deployment can evolve independently.

## Boundaries through Phase 3

- `core/`: shared types, interfaces, errors, and status contracts.
- `config/`: bounded non-secret runtime configuration.
- `database/`: Agent-owned SQLite migrations plus project-database adapter contracts, SQL safety, worker-isolated SQLite access, schema/query/transaction/migration-status services.
- `projects/`: registry and project configuration validation.
- `security/`: authorization, filesystem sandbox, sensitive-file policy, redaction.
- `files/`: project-scoped filesystem tools.
- `commands/`: argv-only restricted process execution.
- `git/`: fixed Git inspection/commit operations without reset/clean/force behavior.
- `jobs/`, `tasks/`, `idempotency/`: durable execution state and repeat-safety foundations.
- `validation/`: per-project Local CI.
- `services/`: narrowly scoped service status/restart abstraction.
- `logs/`: bounded journal-log access with redaction.
- `health/`: service/HTTP-or-HTTPS/database/composite health evaluation with durable records.
- `deployment/`: production-safety workflow orchestration and durable deployment records.

Full recovery/rollback orchestration and MCP transport arrive in Phase 4. MCP will call these services rather than own business logic.

## Database model

Project database access is adapter-based. Phase 3 ships a real SQLite adapter; other declared engines remain explicit extension points rather than pretending to be implemented. Normal query entry points classify SQL before execution. Destructive statements are blocked. SQLite work runs in short-lived worker threads so a timed-out query cannot block the main Agent process.

Database credentials are never stored in Server Agent SQLite. Project database configuration stores non-secret metadata and secret references only.

## Deployment model

Deploy is an orchestration, not a single command:

1. Git status/branch/commit and clean-state checks.
2. Local validation when configured.
3. Database migration-status inspection when a supported database is configured.
4. Task checkpoint plus Git rollback reference.
5. Configured deploy command and/or service restart.
6. Commit/files-changed capture.
7. Health check.
8. Durable success/failure record.

A failed health check cannot produce a successful deployment record.

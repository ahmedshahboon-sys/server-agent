# Architecture

Server Agent separates transport, project operations, safety policy, persistence, deployment, recovery, and host runtime so no remote protocol handler becomes an unrestricted execution layer.

## Final source boundaries

- `core/`: shared types, interfaces, errors, and status contracts.
- `config/`: bounded non-secret runtime configuration and loopback-first MCP binding policy.
- `runtime/`: executable composition root and environment-based remote principal configuration.
- `database/`: Agent-owned SQLite migrations plus project-database adapter contracts, SQL safety, worker-isolated SQLite access, schema/query/transaction/migration-status services.
- `projects/`: registry and project configuration validation.
- `security/`: authorization, filesystem sandbox, sensitive-file policy, redaction.
- `files/`: project-scoped filesystem operations.
- `commands/`: argv-only restricted process execution with timeout/cancellation bounds.
- `git/`: fixed Git inspection/commit operations without reset/clean/force behavior.
- `jobs/`: persistent connection-independent command/test processes and restart reconciliation.
- `tasks/`, `idempotency/`: durable orchestration state, checkpoints, and repeat-safety foundations.
- `validation/`: per-project Local CI with bounded attempts.
- `services/`: narrowly scoped systemd status/restart abstraction.
- `logs/`: bounded journal-log access with redaction.
- `health/`: service/HTTP-or-HTTPS/database/composite health evaluation, SSRF controls, and durable records.
- `deployment/`: precheck/execute/health orchestration and durable deployment records.
- `recovery/`: evidence collection, bounded recovery decisions, migration-safety assessment, and guarded rollback planning/execution.
- `mcp/`: authenticated stateless HTTP transport, public tool schemas/registry, request validation, audit, and remote-response redaction.

MCP calls service-layer APIs; business/safety logic does not live only in transport handlers.

## Runtime topology

The intended installed process is a single Node.js service:

```text
Cloudflare/approved transport (later)
        |
        v
127.0.0.1:8765/mcp
        |
        v
MCP auth + tool/project authorization
        |
        v
transport-independent services
        |
        +--> project sandboxes / Git / registered argv
        +--> Agent SQLite state
        +--> supported project database adapter
        +--> systemd/journal health evidence
```

The runtime composes one Project Registry, one Agent SQLite database, bounded Jobs, Tasks, deployment/recovery engines, and one HTTP MCP server. No Redis, queue server, additional Agent database server, or Docker layer is required.

## Long-running work

Direct remote commands/tests become persistent Jobs and return a `job_id`; the HTTP request does not need to remain alive until the child exits. Task/validation/deployment/recovery state is separately durable. On restart, interrupted task states move to recovery-required state and vanished jobs become `UNKNOWN` rather than being replayed.

## Database model

Project database access is adapter-based. This build implements real SQLite project access; other declared engines remain explicit extension points and fail closed. Normal query entry points classify SQL before execution, block destructive statements, enforce result/time bounds, and store audit hashes rather than SQL text.

Database credentials are never stored in Server Agent SQLite. Project configuration stores non-secret metadata and environment-variable references only.

## Deployment/recovery model

Deploy is a workflow, not a single command: prechecks -> validation -> migration evidence -> checkpoint -> configured action -> Git evidence -> health gate -> durable outcome.

Failure enters evidence-driven recovery. Recovery attempts are bounded and do not invent fixes. Rollback is a separate planned operation that revalidates Git and migration state before executing an explicitly registered rollback argv. Code rollback never silently claims to revert database migrations.

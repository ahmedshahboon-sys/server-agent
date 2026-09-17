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
- `commands/`: argv-only restricted process execution with timeout/cancellation bounds and redacted streaming hooks.
- `git/`: fixed Git inspection/commit operations without reset/clean/force behavior.
- `jobs/`: persistent connection-independent command/test processes, redacted live log files, cancellation, and restart reconciliation.
- `tasks/`: durable orchestration state, checkpoints, atomic state transitions, and links to running Jobs.
- `idempotency/`: durable repeat-safety records plus request-scoped idempotency context.
- `operations/`: project-scoped mutation leases used to prevent overlapping mutating work.
- `validation/`: per-project Local CI with bounded attempts.
- `services/`: narrowly scoped systemd status/restart abstraction.
- `logs/`: bounded journal-log access with redaction.
- `health/`: service/HTTP-or-HTTPS/database/composite health evaluation, SSRF controls, and durable records.
- `deployment/`: precheck/execute/health orchestration and durable deployment records.
- `recovery/`: evidence collection, bounded recovery decisions, migration-safety assessment, and guarded rollback planning/execution.
- `mcp/`: authenticated stateless HTTP transport, public tool schemas/registry, request validation, audit, idempotency context, and remote-response redaction.

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

The runtime composes one Project Registry, one Agent SQLite database, bounded Jobs, Tasks, idempotency/lease state, deployment/recovery engines, and one HTTP MCP server. No Redis, queue server, additional Agent database server, or Docker layer is required.

## Long-running work

Direct remote commands/tests become persistent Jobs and return a `job_id`; the HTTP request does not need to remain alive until the child exits. Job stdout/stderr is appended while the process runs after secret redaction, so useful partial evidence survives an Agent crash.

A Job can be attached to a RUNNING Task. A Task cannot be paused while an attached Job is running. Cancelling the Task first cancels and waits for the attached Job to reach a terminal state and only then records the Task as `CANCELLED`.

On Agent restart, every previously persisted `RUNNING` Job becomes `UNKNOWN`. Server Agent intentionally does not trust a stored PID because that process can outlive the Agent or the PID can be reused by an unrelated process. Interrupted Task states separately move to recovery-required state; mutating work is not replayed automatically.

## Idempotency and mutation serialization

MCP tool calls receive a stable idempotency context. An explicit `idempotency_key` is used when present; otherwise a stable key is derived from the authenticated principal and JSON-RPC request id. Service-layer operations remain transport-independent and consume the context only when they perform a protected mutation.

Job starts, controlled database writes/transactions, and project service restarts use durable idempotency records. Repeating a completed request returns/reuses the stored operation result instead of performing the side effect again. Reusing a key with different input, retrying an operation still marked `IN_PROGRESS`, or silently replaying a previously failed mutation is rejected.

Mutating operations also acquire a durable per-project lease with a bounded TTL. A second mutation for the same project is rejected while that lease is active. If the Agent crashes, the lease is deliberately not assumed free merely because the process disappeared; expired leases are reclaimed during startup. This provides the serialization foundation that deployment/validation/rollback persistent operations will use in the next hardening group.

## Database model

Project database access is adapter-based. This build implements real SQLite project access; other declared engines remain explicit extension points and fail closed. Normal query entry points classify SQL before execution, block destructive statements, enforce result/time bounds, and store audit hashes rather than SQL text.

Database credentials are never stored in Server Agent SQLite. Project configuration stores non-secret metadata and environment-variable references only.

## Deployment/recovery model

Deploy is a workflow, not a single command: prechecks -> validation -> migration evidence -> checkpoint -> configured action -> Git evidence -> health gate -> durable outcome.

Failure enters evidence-driven recovery. Recovery attempts are bounded and do not invent fixes. Rollback is a separate planned operation that revalidates Git and migration state before executing an explicitly registered rollback argv. Code rollback never silently claims to revert database migrations.

# Operations, backup, upgrade, and recovery

## SQLite state

Server Agent uses one SQLite state database and WAL mode. The database contains project registrations, task/job state, deployment/recovery evidence, checkpoints, and MCP audit metadata. It must not contain project secret values.

Default location: `/var/lib/server-agent/server-agent.sqlite`.

### Conservative backup

The safest simple backup procedure is a short maintenance stop so SQLite closes cleanly:

1. `systemctl stop server-agent.service`
2. copy `/var/lib/server-agent/server-agent.sqlite` to a protected backup location;
3. preserve owner/mode metadata and record the Server Agent Git commit;
4. `systemctl start server-agent.service`;
5. verify service health and MCP discovery.

For a zero-downtime backup, use a reviewed SQLite backup mechanism that is aware of WAL state. Do not copy only the main database file while writes are active and assume it is complete.

Project databases are separate assets. Backing up Server Agent state does not back up a project's PostgreSQL/MySQL/MongoDB/SQLite data.

## Logs

The runtime writes structured, redacted process logs to stdout/stderr. Under systemd these are available through journald, for example:

```bash
journalctl -u server-agent.service --since today --no-pager
```

Project log reads exposed through MCP are bounded and project-scoped. In the production package they pass through the Unix-socket host helper and only exact units from `/etc/server-agent/allowed-services` are readable. MCP audit records store principal/credential/tool/project/result metadata but never tool arguments.

## Authentication operations

Bearer secrets are never stored in SQLite as plaintext. Each credential has a non-secret id, principal id, optional expiry, revoke state, last-used time, and SHA-256 token hash. Authentication events and MCP tool audit are retained for the configured audit window.

Use `npm run auth:admin -- ...` locally on the Server Agent host to list credentials, create an additional principal/credential, rotate a credential, revoke a credential, or enable/disable a principal. Do not expose this CLI through MCP. For rotation, provision the new bearer to the client first, verify it, then retire old client configuration; the CLI already marks the old credential revoked atomically when `rotate` completes.

A credential id is immutable token identity. Never overwrite an existing id with different bearer material. If a bootstrap environment token is removed after provisioning, confirm at least one non-expired, non-revoked credential exists first.

## Reproducible dependency and MCP compatibility gate

`package-lock.json` is committed and both development CI and the installation package use `npm ci --ignore-scripts`. GitHub CI runs the full validation suite on Node.js 22 and 24. A separate compatibility job installs the pinned official `@modelcontextprotocol/client@2.0.0` only for testing and verifies the `2026-07-28` modern discovery path, tool listing, and tool invocation against a live loopback Server Agent runtime.

The product remains runtime-dependency-free; the official client is not shipped with Server Agent. This keeps the execution footprint small while continuously detecting protocol drift.

## Maintenance mode, disk pressure, and self-health

Set `SERVER_AGENT_MAINTENANCE_MODE=true` only for an intentional operator maintenance window. Read-only diagnostics remain available, while mutations marked by the MCP registry and the underlying file/job/database/durable-operation guards fail closed.

The runtime exposes unauthenticated loopback-oriented self-health endpoints on the same listener:

- `GET /healthz`: process liveness only;
- `GET /readyz`: state-database queryability plus configured free-disk headroom.

Keep these endpoints behind the same local/tunnel boundary as MCP. They contain bounded process/disk state only and no project secrets.

`SERVER_AGENT_MIN_FREE_DISK_BYTES` is a pre-mutation floor. When free space drops below the floor, new writes/jobs/durable operations are rejected before work begins. `SERVER_AGENT_STATE_DB_WARNING_BYTES` is surfaced through `system_snapshot` metrics to flag state/WAL growth before it becomes a disk incident.

Startup maintenance retains durable task/deployment/rollback evidence while pruning older low-value telemetry according to `SERVER_AGENT_OPERATIONAL_RETENTION_DAYS`, older terminal job log files according to `SERVER_AGENT_JOB_LOG_RETENTION_DAYS`, and audit records according to the existing audit-retention setting. A passive SQLite WAL checkpoint is issued after pruning.

## MCP Tasks extension

For protocol `2026-07-28`, clients that advertise `io.modelcontextprotocol/tasks` may receive a task handle from durable validation/deploy/recovery/rollback tool calls. Poll with `tasks/get`; `Mcp-Name` must equal the returned `taskId`. Cancellation is cooperative: `tasks/cancel` records operator intent, but a safety-critical operation is allowed to continue to a verified terminal state rather than being killed mid-transition.

Clients that do not advertise the extension keep the original Server Agent durable-operation response shape, preserving backward compatibility.

## Safe upgrade

Before an upgrade:

1. confirm the current service is healthy;
2. record the current Server Agent Git commit;
3. back up Server Agent SQLite and `/etc/server-agent` securely;
4. inspect `git status` and preserve any intentional local changes;
5. fetch the reviewed target commit without `reset --hard`, `git clean`, force checkout, or force push;
6. run development/package validation and build;
7. restart the service only after validation passes;
8. verify MCP discovery, journal logs, memory, registered projects, and task recovery state.

If an upgrade changes the Server Agent SQLite schema, its migrations are forward-applied by the runtime. Do not substitute a Git code rollback for a database-state rollback. Restore state only from a known compatible backup after explicit review.

## Crash/restart recovery

On startup:

- interrupted task states are converted to `RECOVERY_REQUIRED`;
- jobs recorded as running are checked for process liveness;
- vanished jobs become `UNKNOWN` rather than being replayed;
- no failed mutation, deployment, migration, or rollback is blindly rerun.

Recovery assessment is evidence-driven. Automatic recovery attempts are bounded; when a safe continuation cannot be proven, state moves toward rollback planning or `WAITING_FOR_USER`.

## Project rollback

Rollback is a planned operation, not `git reset --hard`. The rollback engine requires a persisted plan, last-known-good reference, clean/revalidated Git state, an explicit registered rollback command containing `{target_commit}`, migration-safety evidence, and post-rollback health validation when configured.

If database migration state changed or cannot be proven compatible, automatic code rollback is blocked or requires manual database review.

## Service permissions

The main `server-agent` Linux user has no blanket sudo and is not added to `systemd-journal`. A dedicated root helper service receives structured requests over a local Unix socket and independently checks `/etc/server-agent/allowed-services` before calling `systemctl` or `journalctl`. Keep that allowlist minimal and root-owned. Removing a unit from the allowlist immediately causes host-level operations for that unit to fail closed on the next request.

## Uninstall

Use `install/uninstall.sh` only to remove/disable the Server Agent systemd service. State, configuration, source, and registered project files are intentionally preserved. Review backups before any later manual deletion.

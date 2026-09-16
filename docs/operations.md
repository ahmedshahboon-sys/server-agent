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

Project log reads exposed through MCP are bounded and project-scoped. MCP audit records store principal/tool/project/result metadata but never tool arguments.

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

The installation package does not grant the `server-agent` Linux user blanket sudo access. Project service restarts may therefore remain unavailable until the operator deliberately configures a narrow OS authorization mechanism. Prefer allowing only exact registered services rather than generic `systemctl` privilege.

## Uninstall

Use `install/uninstall.sh` only to remove/disable the Server Agent systemd service. State, configuration, source, and registered project files are intentionally preserved. Review backups before any later manual deletion.

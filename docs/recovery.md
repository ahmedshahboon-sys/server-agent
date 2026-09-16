# Recovery and rollback

Phase 4 implements evidence-driven recovery and guarded rollback on top of the durable task/job state introduced in Phase 2 and deployment records introduced in Phase 3.

## Recovery

Interrupted tasks are never assumed successful and mutating work is never replayed automatically. A recovery assessment collects bounded, redacted evidence from the task checkpoint, deployment record, validation/job state, Git state, health history, and available project logs. The engine then records one of these decisions:

- `RESUME_RECOMMENDED` — a persistent checkpoint or confirmed deployment state exists. The caller may explicitly resume after reviewing evidence.
- `ROLLBACK_REQUIRED` — a failed deployment has a last-known-good rollback reference.
- `WAITING_FOR_USER` / `MANUAL_REQUIRED` — the agent cannot prove a safe automatic next step.

Recovery attempts are bounded by `SERVER_AGENT_MAX_RECOVERY_ATTEMPTS` (default `3`). When the limit is reached, Server Agent stops retrying and moves the task to rollback-required or user-intervention state. There is no unlimited self-healing loop.

## Rollback

Rollback is deliberately split into `rollback_plan` and `rollback_execute`.

A plan is `READY` only when all required evidence is safe: the last-known-good Git commit exists, the working tree is clean, current HEAD matches the deployed state, migration evidence permits code rollback, an explicit project rollback command is registered, and required project capabilities are enabled.

The rollback command must contain `{target_commit}` and receives a full Git commit SHA. Generic `run_command` cannot invoke the rollback command. Immediately before execution the engine revalidates Git and migration state; any drift changes the plan to `BLOCKED` instead of guessing.

Database rollback is not treated as equivalent to Git rollback. If migration state is unknown or the migration version changed, automatic database rollback is forbidden and manual intervention is required. Destructive database rollback is never invented by Server Agent.

After code rollback, configured service restart and health validation run through the existing restricted service and health layers. A successful rollback places the task in `ROLLED_BACK`; a failed or unsafe rollback ends in a user-intervention state with redacted evidence.

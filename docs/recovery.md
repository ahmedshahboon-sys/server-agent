# Recovery and rollback

Server Agent keeps durable task/job/deployment state in SQLite so connection loss or process restart does not imply success and does not trigger blind replay.

## Startup reconciliation

On Agent startup:

- tasks left in `RUNNING`, `DEPLOYING`, `HEALTH_CHECKING`, `RECOVERING`, or `ROLLING_BACK` are moved to `RECOVERY_REQUIRED`;
- Jobs recorded as `RUNNING` are checked for process liveness;
- a vanished Job becomes `UNKNOWN`;
- no command, migration, deploy, or rollback is automatically repeated merely because a prior connection disappeared.

## Evidence-driven recovery

`recovery_assess` collects bounded persisted evidence such as task checkpoint/state, recent validation results, Jobs, health checks, deployment state, Git status/HEAD/diff summary, and bounded journal logs when permitted.

Recovery returns one of three high-level directions:

- `RESUME_RECOMMENDED` when a confirmed checkpoint/deployment state supports safe continuation;
- `ROLLBACK_REQUIRED` when a failed deployment has an available last-known-good rollback reference;
- `WAITING_FOR_USER` when a safe automatic direction cannot be proven.

Recovery attempts are bounded by `SERVER_AGENT_MAX_RECOVERY_ATTEMPTS` (default 3). Hitting the limit moves toward rollback/manual state rather than looping indefinitely.

## Rollback planning

Rollback is not exposed as `git reset --hard` or a generic Git command. `rollback_plan` verifies evidence including:

- task/deployment relationship;
- last-known-good target commit availability;
- current Git HEAD and clean working tree;
- configured rollback argv containing the explicit `{target_commit}` placeholder;
- project command/health permissions;
- database migration status compared with pre-deploy evidence.

A plan becomes `READY` only when those checks are safe. Otherwise it becomes `BLOCKED` and the task moves to manual/user review.

## Rollback execution

`rollback_execute` accepts only a persisted READY plan, revalidates Git and migration state immediately before execution, runs the registered rollback argv with a full validated Git SHA, optionally restarts the configured project service, and runs post-rollback health when configured.

Successful code rollback records the final HEAD/health and moves the task to `ROLLED_BACK`. Failed rollback records redacted evidence and moves the task to `WAITING_FOR_USER`.

## Database boundary

Database rollback is never inferred from Git rollback. If the migration system/version changed or migration state is unknown, rollback safety becomes `MANUAL_REQUIRED` or `BLOCKED`. Destructive database recovery requires explicit operator review outside the normal automatic rollback path.

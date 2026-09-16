# Recovery state foundations

Phase 2 adds durable task and job state in SQLite.

On Agent startup, tasks left in `RUNNING`, `DEPLOYING`, `HEALTH_CHECKING`, or `RECOVERING` are not assumed successful. They are moved to `RECOVERY_REQUIRED` before resume logic continues.

Jobs persist their pid, task/project relationship, command id, timestamps, status, exit code, and bounded output-file locations. After restart, a job recorded as `RUNNING` is checked for process liveness. A vanished process becomes `UNKNOWN`; Server Agent does not blindly execute it again.

Full evidence-driven recovery and rollback orchestration is Phase 4. Phase 2 only establishes durable state, checkpoints, process reconciliation, and retry/idempotency foundations.

# Deployment engine

Server Agent's deployment engine is transport-independent. Source development and GitHub Actions use only fixtures/mocks/local processes; CI never connects to a production server or production database.

## Pre-deploy checks

A deployment verifies the registered project, Git branch, working-tree cleanliness policy, current commit, changed-file/diff summary, configured Local CI validation, and migration status for a supported configured database. It creates a task checkpoint and stores the Git rollback reference before deployment actions begin.

Deployment strategies are explicit project configuration:

- `none`: deployment disabled;
- `command`: run the registered `deploy` argv;
- `restart-only`: restart the configured service without a project deploy command.

Command execution remains argv-only and project-registered. Service restart remains a narrow systemd abstraction, not an unrestricted root shell, and may fail closed until the host grants the dedicated Agent user a deliberately narrow authorization policy.

## Health gate

After execution, Server Agent captures post-deploy commit/files changed and runs the configured health check. If health is required and the result is not `HEALTHY`, the deployment record becomes `FAILED`; command exit zero alone never proves deployment success.

HTTP health probes resolve DNS first, reject private/reserved targets, connect to the validated IP, and do not follow redirects.

## Failure and recovery

A failed deployment preserves evidence and task/deployment state. Recovery assessment uses persisted checkpoints, validation/jobs/health/Git/log evidence and bounded attempts. It does not blindly rerun a deploy.

If a last-known-good rollback reference exists, recovery may require rollback planning. Rollback execution is separate and requires a persisted READY plan, clean/revalidated Git state, an explicit registered rollback command containing `{target_commit}`, database-migration safety review, and post-rollback health when configured.

Git rollback and database rollback are intentionally separate. If migration state changed or is unknown, automatic code rollback is blocked or moved to manual review rather than pretending the database was reverted.

## Production boundary

The Phase 5 repository contains installation and operations documentation, but no GitHub workflow deploys to production. Actual Server Agent installation, project registration, Cloudflare Tunnel/Access setup, and production permission changes happen only in the later explicit installation workflow.

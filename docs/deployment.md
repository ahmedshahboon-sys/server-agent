# Deployment engine

Phase 3 implements the transport-independent deployment engine. It is tested only with local fixtures/mocks during source development; no production server is contacted by GitHub Actions.

## Pre-deploy checks

A deployment verifies the project, Git branch, working-tree cleanliness policy, current commit, changed-file/diff summary, Local CI validation, and migration status for a supported configured database. It then creates a task checkpoint and stores the Git rollback reference before executing deployment actions.

Deployment strategies are explicit project configuration:

- `none`: deployment disabled;
- `command`: run the registered `deploy` argv;
- `restart-only`: restart the configured service without a project deploy command.

Optional service restart remains a narrow systemd action, never an unrestricted root shell.

## Health gate

After execution Server Agent records the post-deploy commit/files changed and runs the configured health check. If health is required and the result is not `HEALTHY`, the deployment record becomes `FAILED`; it is never marked successful merely because the command exited zero.

Phase 4 adds evidence-driven recovery and rollback execution. Phase 3 only prepares durable rollback state and deployment evidence.

Production installation, systemd unit installation, Cloudflare Tunnel, authentication, and ChatGPT Remote MCP connection remain outside source-build Phase 3.

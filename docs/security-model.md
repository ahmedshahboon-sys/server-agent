# Security model

## Default deny and project scope

An operation requires explicit caller permission/project scope and the registered project must enable the capability. Cross-project access remains denied.

## Filesystem and commands

Canonical `realpath` sandboxing prevents traversal and symlink escape. Sensitive files are blocked from ordinary file tools. Project commands are fixed argv arrays executed with `shell: false`; dangerous shell/system-control executables are blocked from the generic command tool.

## Database safety

`database_query` classifies a single SQL statement before execution. Reads and controlled writes are separate permissions. Writes also require the project to opt into `controlled-write`. `DROP DATABASE`, `DROP TABLE`, `TRUNCATE`, destructive `ALTER ... DROP`, and `DELETE` without `WHERE` are blocked from the normal interface. Transaction-control SQL is not accepted through `database_query`; transactions use the dedicated transaction API.

Returned rows and bytes are bounded. SQLite operations run in short-lived worker threads with a hard timeout so a long query cannot block the main Agent. Database audit records store a SHA-256 statement hash, classification, outcome, and counts—not SQL text or credentials.

## Health and SSRF boundary

HTTP/HTTPS health URLs are derived from the registered project domain and registered health path, not arbitrary caller URLs. Userinfo, path-bearing domains, localhost, metadata hostnames, and private/loopback IP literals are rejected, and redirects are disabled. This keeps health checks from becoming a generic URL-fetch primitive.

## Deployment safety

A successful command is not enough for deployment success. Git/precheck/validation/migration checkpointing runs first, then deployment, then health. A failed required health check produces a failed deployment record with rollback reference preserved for Phase 4.

## Services and logs

Service operations use strict systemd unit names and fixed `systemctl` argv. Journal reads are line/output bounded and secret-redacted. They do not expose an arbitrary shell.

## Secrets and GitHub CI

Structured output and persisted errors are redacted. Secrets are referenced by environment name rather than stored in Registry/Task/Deployment state. GitHub-hosted CI remains development-only with no production credentials, SSH, database access, or deployment step.

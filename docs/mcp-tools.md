# Remote MCP boundary and tools

Server Agent implements a stateless HTTP MCP boundary for protocol `2026-07-28`. Core services remain transport-independent; the MCP layer performs authentication, permission/scope checks, schema validation, redaction, idempotency context propagation, and bounded response handling before/after calling them.

## Request envelope

Modern requests must carry matching transport and `_meta` protocol information:

- `MCP-Protocol-Version: 2026-07-28`
- `Mcp-Method: <json-rpc method>`
- `Mcp-Name: <tool name>` for `tools/call`
- JSON-RPC `params._meta.io.modelcontextprotocol/protocolVersion`
- JSON-RPC `params._meta.io.modelcontextprotocol/clientCapabilities` as an object

The Server Agent endpoint also requires `Authorization: Bearer <agent credential>`. Requests with an `Origin` header are accepted only when that exact origin is configured in `SERVER_AGENT_MCP_ALLOWED_ORIGINS`.

Supported protocol methods are `server/discover`, `tools/list`, and `tools/call`. Session ids are rejected because this implementation is intentionally stateless.

## Authentication, authorization, and repeat safety

Bearer authentication identifies a remote principal. It does not bypass authorization. Every project operation remains constrained by:

1. tool permission;
2. principal project scope;
3. registered project capability;
4. operation-specific safety controls.

`tools/list` is permission-filtered. Cross-project access is denied. Tool arguments are not stored in MCP audit rows.

Each tool call also receives an idempotency context. If `idempotency_key` is supplied it is used after validation; otherwise Server Agent derives a stable opaque key from the authenticated principal and JSON-RPC request id. Protected mutations such as Job start, controlled database write/transaction, and service restart persist the key and input fingerprint. A completed duplicate reuses the stored result; an in-progress, failed, or same-key/different-input request fails closed rather than repeating the side effect.

Protected mutations acquire a per-project durable lease. A second protected mutation for that project cannot overlap while the lease is active. Expired leases are reclaimed on startup; a crash does not cause Server Agent to assume the old mutation is harmlessly gone.

## Tool surface

### Projects

- `list_projects`
- `get_project`
- `register_project`
- `update_project`
- `disable_project`
- `remove_project` — archives the registry entry (tombstone) so historical task/job/deployment foreign keys remain valid; project files are never deleted

Archived projects disappear from normal project lookups/lists and their IDs are not silently reusable.

### Files

- `list_files`
- `read_file` — returns `content` plus a SHA-256 version
- `search_files`
- `write_file` — same-directory temporary file + sync + atomic rename
- `edit_file` — requires the SHA-256 returned by the prior read and refuses stale edits
- `delete_file`

Sensitive credential/config paths are denied by default, including common environment, SSH, package-manager, cloud, Docker, Kubernetes, and Terraform credential/state locations.

### Git

- `git_status`
- `git_diff`
- `git_log`
- `git_branch`
- `git_commit`

`git_commit` requires 1-256 explicit project paths and commits only those paths; unrelated pre-staged changes are excluded. No reset-hard, clean, force checkout, force push, or generic Git argv tool is exposed.

### Commands, Jobs, validation

- `run_command` — starts a registered command as a persistent Job; optional `task_id` links it to a RUNNING Task
- `run_tests` — starts the registered test command as a persistent Job; optional `task_id` links it to a RUNNING Task
- `job_status`
- `list_jobs`
- `cancel_job`
- `run_validation`

Arbitrary shell strings/argv are not accepted. Job stdout/stderr is appended to bounded log files during execution only after secret redaction. The Job tools let the client reconnect and inspect work without blindly rerunning it.

After Agent restart, previously persisted `RUNNING` Jobs become `UNKNOWN` regardless of whether their stored PID currently exists. The PID may belong to a surviving child or may have been reused; Server Agent therefore does not attach to or kill it automatically.

### Tasks

- `create_task`
- `task_status`
- `list_tasks`
- `resume_task`
- `pause_task`
- `cancel_task`

Task transitions are compare-and-set guarded. A Task with a running linked Job cannot be paused. Cancelling it cancels and waits for that Job before the Task itself becomes `CANCELLED`.

### Database

- `database_status`
- `database_schema`
- `database_query`
- `database_transaction`
- `database_migration_status`

Destructive SQL is blocked from the normal interface. SQLite read queries are iterated under row/byte bounds so a large result is not materialized before limits are applied. Write classification still requires explicit write authorization inside the database service even though the generic query tool is visible to read-authorized callers. Controlled writes and write-containing transactions use idempotency + per-project mutation leases when invoked through the hardened runtime.

### Deployment / health / services / logs

- `deploy`
- `deployment_status`
- `health_check`
- `get_logs`
- `service_status`
- `service_restart`

Project service restart is idempotent and lease-guarded in the hardened runtime. Host-level service restart may remain unavailable until a deliberately narrow Linux authorization policy exists; the installer does not grant it automatically.

Deployment and validation themselves are still synchronous orchestration in this group; their conversion to persistent Operations belongs to the next hardening group.

### Recovery / rollback

- `recovery_assess`
- `recovery_status`
- `rollback_plan`
- `rollback_status`
- `rollback_execute`

Recovery is evidence-driven and bounded. Rollback execution requires a previously READY plan and immediate revalidation. Persistent operation conversion for deployment/validation/rollback is intentionally deferred to the next hardening group.

### Diagnostics

- `system_snapshot`
- `project_diagnostics`

Diagnostics are bounded and secret-redacted; `system_snapshot` requires global project scope.

## Remote exposure

The recommended installation keeps Server Agent on loopback and places an authenticated Cloudflare Tunnel/Access layer in front of it. Cloudflare transport never replaces Server Agent bearer authentication or per-project authorization. See `docs/cloudflare-remote-mcp.md`.

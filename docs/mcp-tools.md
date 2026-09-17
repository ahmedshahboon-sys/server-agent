# Remote MCP boundary and tools

Server Agent implements a stateless HTTP MCP boundary for protocol `2026-07-28`. Core services remain transport-independent; the MCP layer performs authentication, permission/scope checks, schema validation, redaction, and bounded response handling before/after calling them.

## Request envelope

Modern requests must carry matching transport and `_meta` protocol information:

- `MCP-Protocol-Version: 2026-07-28`
- `Mcp-Method: <json-rpc method>`
- `Mcp-Name: <tool name>` for `tools/call`
- JSON-RPC `params._meta.io.modelcontextprotocol/protocolVersion`
- JSON-RPC `params._meta.io.modelcontextprotocol/clientCapabilities` as an object

The Server Agent endpoint also requires `Authorization: Bearer <agent credential>`. Requests with an `Origin` header are accepted only when that exact origin is configured in `SERVER_AGENT_MCP_ALLOWED_ORIGINS`.

Supported protocol methods are `server/discover`, `tools/list`, and `tools/call`. Session ids are rejected because this implementation is intentionally stateless.

## Authentication and authorization

Bearer authentication identifies a remote principal. It does not bypass authorization. Every project operation remains constrained by:

1. tool permission;
2. principal project scope;
3. registered project capability;
4. operation-specific safety controls.

`tools/list` is permission-filtered. Cross-project access is denied. Tool arguments are not stored in MCP audit rows.

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

- `run_command` — starts a registered command as a persistent Job
- `run_tests` — starts the registered test command as a persistent Job
- `job_status`
- `list_jobs`
- `cancel_job`
- `run_validation`

Arbitrary shell strings/argv are not accepted. The Job tools let the client reconnect and inspect work without blindly rerunning it.

### Tasks

- `create_task`
- `task_status`
- `list_tasks`
- `resume_task`
- `pause_task`
- `cancel_task`

### Database

- `database_status`
- `database_schema`
- `database_query`
- `database_transaction`
- `database_migration_status`

Destructive SQL is blocked from the normal interface. SQLite read queries are iterated under row/byte bounds so a large result is not materialized before limits are applied. Write classification still requires explicit write authorization inside the database service even though the generic query tool is visible to read-authorized callers.

### Deployment / health / services / logs

- `deploy`
- `deployment_status`
- `health_check`
- `get_logs`
- `service_status`
- `service_restart`

Host-level service restart may remain unavailable until a deliberately narrow Linux authorization policy exists; the installer does not grant it automatically.

### Recovery / rollback

- `recovery_assess`
- `recovery_status`
- `rollback_plan`
- `rollback_status`
- `rollback_execute`

Recovery is evidence-driven and bounded. Rollback execution requires a previously READY plan and immediate revalidation.

### Diagnostics

- `system_snapshot`
- `project_diagnostics`

Diagnostics are bounded and secret-redacted; `system_snapshot` requires global project scope.

## Remote exposure

The recommended installation keeps Server Agent on loopback and places an authenticated Cloudflare Tunnel/Access layer in front of it. Cloudflare transport never replaces Server Agent bearer authentication or per-project authorization. See `docs/cloudflare-remote-mcp.md`.

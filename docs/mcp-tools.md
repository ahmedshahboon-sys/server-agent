# Remote MCP boundary

Phase 4 exposes the transport-independent Server Agent services through an authenticated, project-scoped MCP HTTP boundary. The transport is intentionally separate from files, Git, database, tasks, deployment, recovery, and rollback logic.

## Transport and authentication

The Phase 4 transport targets MCP protocol `2026-07-28` over stateless HTTP. It accepts only the configured MCP path and `POST` requests with JSON bodies, enforces a body-size limit, validates `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name`, and does not create server sessions.

An `McpAuthenticator` abstraction sits in front of all MCP methods. `RejectAllAuthenticator` is the safe default building block and `StaticBearerAuthenticator` exists for controlled development/integration. Production identity is deliberately not hard-wired into the core. Cloudflare Tunnel / Access integration remains an installation-stage concern.

When an `Origin` header is present it must match the configured allowlist. Unknown origins are rejected. The transport is not an arbitrary URL fetcher and does not expose an unrestricted shell.

## Authorization

Authentication only establishes a `Principal`; it does not grant project access by itself. Each tool then passes:

1. tool permission check,
2. project-scope check,
3. registered project-capability check in the underlying service or tool boundary,
4. the existing filesystem / command / database / deployment safety layer.

`tools/list` is filtered to permissions visible to the principal. Global operations such as project registration and `system_snapshot` additionally require global project scope (`*`). MCP audit records contain request/principal/tool/project outcome metadata only, never tool arguments.

## Exposed tool groups

- Projects: `list_projects`, `get_project`, `register_project`, `update_project`, `disable_project`, `remove_project`. `remove_project` removes only the Server Agent registry row and never deletes project files.
- Files: `list_files`, `read_file`, `search_files`, `write_file`, `edit_file`, `delete_file`.
- Git / commands: `git_status`, `git_diff`, `git_log`, `git_branch`, `git_commit`, `run_command`, `run_tests`, `run_validation`.
- Tasks: `create_task`, `task_status`, `list_tasks`, `resume_task`, `pause_task`, `cancel_task`.
- Database: `database_status`, `database_schema`, `database_migration_status`, `database_query`, `database_transaction`.
- Operations: `get_logs`, `service_status`, `service_restart`, `health_check`, `deploy`, `deployment_status`.
- Recovery / rollback: `recovery_assess`, `recovery_status`, `rollback_plan`, `rollback_status`, `rollback_execute`.
- Diagnostics: `system_snapshot`, `project_diagnostics`.

Rollback cannot be executed through generic `run_command`; it requires a persisted `READY` plan and revalidation immediately before execution.

## Remote responses

Successful values and errors pass through recursive secret redaction before leaving the MCP boundary. Bearer credentials, secret-shaped keys, private keys, credential-bearing URLs, and configured secret values are not intentionally returned. Sensitive project files remain blocked by the filesystem policy regardless of MCP authorization.

Phase 4 does not publish DNS, open a public port, install Cloudflare, or access Production. Remote exposure and identity-provider setup are deferred to the installation work after all five source-build phases pass CI.

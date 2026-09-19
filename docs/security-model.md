# Security model

Server Agent is a deterministic safety/execution boundary. ChatGPT or another MCP client may reason about work, but every operation is constrained again inside Server Agent.

## Default deny and project isolation

A remote call must pass authentication, tool permission, principal project scope, and the registered project's own capability list. Projects are isolated by id and canonical root. Cross-project calls fail even when the caller possesses the matching tool permission for another project.

Registry management permissions are separate from runtime project capabilities. The former can register or change configuration; the latter only describe what an already-registered project may expose operationally. `project:manage` is not accepted. Root and capability-list changes require dedicated permissions and global scope. Project configuration is parsed and validated with unknown nested fields rejected before persistence.

## Filesystem boundary

The sandbox validates canonical paths rather than string prefixes. It rejects traversal, encoded traversal, absolute escapes, null bytes, symlink escapes, and access to sensitive filenames such as `.env`, private keys, credential/secrets files, and authentication-token files.

Write/edit/delete operations stay inside the registered project root. Removing a project from the registry removes metadata only; it never deletes the project's files.

## Commands

There is no general remote shell. Commands are registered argv arrays, executed with `shell:false`, inside the project root, with a reduced environment, bounded output, timeout, and cancellation. Dangerous shell/system executables are denied. Git force/reset-hard/clean operations are not exposed.

Remote `run_command` and `run_tests` create persistent Jobs. The MCP connection does not need to remain open while the child process runs. Job state, pid, bounded output locations, exit status, and reconciliation state survive Agent restarts. Cancellation escalates from `SIGTERM` to `SIGKILL` if a child refuses to stop.

## Secrets and remote responses

Secret-like keys/strings, private keys, bearer tokens, credential URLs, and explicitly injected project secret values are redacted before persistence/logging/remote output where applicable. MCP audit stores request/principal/tool/project/result metadata but not tool arguments.

Repository CI scans tracked non-test source for common credential material, including GitHub/OpenAI-style tokens, private keys, Cloudflare tunnel token patterns, production credential assignments, and real Server Agent bearer-token assignments.

## Persistent authentication and audit

Remote credentials are multi-principal and multi-token. SQLite stores only SHA-256 bearer hashes plus non-secret credential ids, principal scopes/permissions, optional expiry, revoke state, created/updated times, and last-used time. Rotation creates a new credential id and revokes the old credential atomically. Revoked, expired, disabled-principal, or unknown credentials fail closed.

Authentication attempts are bounded per remote address and authenticated requests are bounded per principal. Rate-limited requests return HTTP 429. Authentication audit records outcome/principal/credential metadata without bearer material; MCP audit additionally records the non-secret credential id. Both authentication and MCP audit tables are pruned by a configured retention window at startup.

## MCP boundary

The executable runtime binds to loopback by default. A non-loopback bind is rejected unless `SERVER_AGENT_MCP_ALLOW_PUBLIC_BIND=true` is explicitly configured.

The HTTP boundary validates content type, request-size limit, exact MCP path, Origin when present, modern MCP protocol version metadata, client-capabilities metadata, method/name headers, authentication, and tool authorization. MCP sessions are not enabled for the stateless `2026-07-28` transport implemented here.

## URL/SSRF protection

HTTP(S) health probes are the only normal feature that opens an outbound URL connection. The project supplies a hostname and health path, not an arbitrary request object. Before connecting, Server Agent resolves DNS, rejects any private/reserved/local answer, and then connects to the validated public IP while preserving the original HTTP Host/TLS SNI. Redirects are not followed. This reduces both direct-private-target and DNS-rebinding SSRF paths.

## Database safety

Project database access defaults to read. SQL is classified before execution; destructive statements and manual transaction control are blocked from the normal query interface. Writes require both principal and project permission plus controlled-write project configuration. Queries have timeout/result bounds, and audit stores statement hashes rather than SQL text.

SQLite is the directly implemented project adapter in this build. Unsupported adapters fail closed.

## Deployment, recovery, rollback

Deployment records prechecks, Git state, validation, migration status, commands, health, and rollback references. A deploy is not considered successful until its configured health requirement passes.

Recovery collects evidence and uses bounded attempts. It never invents code fixes or blindly replays a mutating step. Rollback requires a persisted READY plan, an explicit configured rollback command containing `{target_commit}`, revalidation of Git state, migration-safety review, and post-rollback health when configured. Git rollback never claims to roll back a database.

## Host privilege boundary

The main service runs as a dedicated non-root user with `NoNewPrivileges`, an empty Linux capability bounding set, `ProtectHome=true`, restrictive umask, and additional kernel/host protections. The installer refuses a runtime tree owned by the service user or group/world-writable runtime paths.

System service status/restart and project journal reads do not use blanket sudo and do not add the service user to `systemd-journal`. A separate root helper listens only on a local Unix socket, has no IP networking, reads an exact root-owned service allowlist, and accepts only `status`, `restart`, or bounded `logs` requests for allowlisted `.service` units. The helper itself uses `ProtectSystem=strict`, `NoNewPrivileges`, an empty capability bounding set, and `RestrictAddressFamilies=AF_UNIX`.

The installer still does not modify firewall, Nginx, DNS, Cloudflare, or registered projects.

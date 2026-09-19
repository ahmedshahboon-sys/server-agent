# Configuration

Server Agent reads configuration from environment variables. The systemd package uses `/etc/server-agent/server-agent.env`; the repository contains examples only.

## Runtime/state

| Variable | Default / guidance |
|---|---|
| `SERVER_AGENT_DATA_DIR` | `./.runtime` in development; `/var/lib/server-agent` in install example |
| `SERVER_AGENT_DB_PATH` | `<dataDir>/server-agent.sqlite` |
| `SERVER_AGENT_LOG_LEVEL` | `info` |
| `SERVER_AGENT_MAX_FILE_BYTES` | `1048576` |
| `SERVER_AGENT_MAX_COMMAND_OUTPUT_BYTES` | `262144` |
| `SERVER_AGENT_COMMAND_TIMEOUT_MS` | `120000` |
| `SERVER_AGENT_MAX_FIX_ATTEMPTS` | `3` |
| `SERVER_AGENT_MAX_CONCURRENT_JOBS` | `1` |
| `SERVER_AGENT_DATABASE_QUERY_TIMEOUT_MS` | `10000` |
| `SERVER_AGENT_DATABASE_MAX_ROWS` | `500` |
| `SERVER_AGENT_DATABASE_MAX_RESULT_BYTES` | `1048576` |
| `SERVER_AGENT_MAX_LOG_OUTPUT_BYTES` | `262144` |
| `SERVER_AGENT_MAX_RECOVERY_ATTEMPTS` | `3` |
| `SERVER_AGENT_AUTH_ATTEMPTS_PER_MINUTE` | `30` per remote address |
| `SERVER_AGENT_AUTH_REQUESTS_PER_MINUTE` | `120` per authenticated principal |
| `SERVER_AGENT_AUDIT_RETENTION_DAYS` | `30`; pruned at startup |

## MCP transport

| Variable | Default / guidance |
|---|---|
| `SERVER_AGENT_MCP_HOST` | `127.0.0.1` |
| `SERVER_AGENT_MCP_PORT` | `8765` |
| `SERVER_AGENT_MCP_PATH` | `/mcp` |
| `SERVER_AGENT_MCP_MAX_BODY_BYTES` | `1048576` |
| `SERVER_AGENT_MCP_ALLOWED_ORIGINS` | comma-separated exact HTTP(S) origins; empty means requests carrying an Origin are denied |
| `SERVER_AGENT_MCP_ALLOW_PUBLIC_BIND` | `false`; must be explicitly `true` for any non-loopback bind |

The recommended remote architecture keeps MCP on loopback and uses a local Cloudflare Tunnel/reverse transport. Do not set `0.0.0.0` merely to make remote setup easier.

## Remote principal authentication/authorization

The executable runtime also requires:

- `SERVER_AGENT_MCP_BEARER_TOKEN` — optional bootstrap credential after initial provisioning; 32-4096 characters and never stored in SQLite as plaintext;
- `SERVER_AGENT_MCP_PRINCIPAL_ID` — safe audit identity, default `chatgpt-remote`;
- `SERVER_AGENT_MCP_CREDENTIAL_ID` — non-secret credential identifier, default `bootstrap-chatgpt`;
- `SERVER_AGENT_MCP_CREDENTIAL_EXPIRES_AT` — optional ISO timestamp for the bootstrap credential;
- `SERVER_AGENT_MCP_PROJECT_SCOPES` — comma-separated explicit project ids; `*` is reserved for intentional global administration and is not the example default;
- `SERVER_AGENT_MCP_PERMISSIONS` — comma-separated known Server Agent permissions.

Authentication grants no project capability by itself. A call must pass all three layers:

1. the remote principal has the tool permission;
2. the principal scope includes the requested project;
3. the registered project explicitly permits the operation.

Start with read-oriented permissions and explicit project ids. The shipped environment examples use `example-project`, not `*`. Expand scope or grant registry-management permissions only for an intentional administrative workflow; normal runtime project capabilities do not grant registry-management authority.

On first successful startup, the bootstrap bearer is hashed with SHA-256 and stored with its credential id, principal, expiry, revoke state, and last-used timestamp. A restart with the same credential id but different token fails closed; rotation must use a new credential id. Once at least one usable credential exists in SQLite, the bootstrap token may be removed from the environment. Use the local `auth:admin` CLI for additional principals, rotation, revoke, enable/disable, and credential listing. Bearer tokens are shown only when newly created or rotated.

## Host helper

`SERVER_AGENT_HOST_HELPER_SOCKET=/run/server-agent-host/hostctl.sock` routes systemd status/restart and project journal reads to the isolated root helper service. The helper accepts only structured requests for exact `.service` names present in `/etc/server-agent/allowed-services`. The main Agent never receives root, sudo, or broad journal-group membership.

## Secrets

Project database/runtime credentials are referenced by environment-variable names such as `PROJECT_A_DB_URL`; secret values are not stored in project registration records. Sensitive file reads remain denied even when the caller has normal file-read permission.

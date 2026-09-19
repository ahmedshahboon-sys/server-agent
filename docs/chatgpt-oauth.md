# ChatGPT OAuth for remote MCP

Server Agent can expose its existing bearer-authenticated MCP endpoint to ChatGPT through an optional, self-hosted OAuth 2.1 authorization layer. OAuth is disabled by default and does not replace the existing local/bootstrap bearer credential.

## Security model

- MCP stays bound to loopback (`127.0.0.1`) when used behind Cloudflare Tunnel.
- OAuth is enabled only when `SERVER_AGENT_OAUTH_ENABLED=true`.
- `SERVER_AGENT_PUBLIC_BASE_URL` must be an HTTPS origin and is used as both the OAuth issuer and protected-resource identifier.
- The owner authorization secret is read only from the root-owned Server Agent environment file. It is never stored in SQLite, returned to the OAuth client, or logged.
- Dynamic Client Registration (DCR) is supported for compatibility with ChatGPT public clients. Registered redirect URIs are restricted to configured origins; the install example allows only `https://chatgpt.com`.
- Authorization Code + PKCE is mandatory and only `S256` is accepted.
- Authorization responses include the RFC 9207 `iss` parameter.
- Authorization codes are one-time, expire after five minutes, and are stored only as SHA-256 hashes.
- Access tokens are opaque high-entropy bearer credentials stored through the normal Server Agent credential store as hashes only.
- Refresh tokens are opaque, hash-only, bound to client/resource/principal, and rotated on every refresh. They are issued only when the client requests the standard `offline_access` scope.
- The OAuth principal cannot use global `*` project scope.
- This implementation intentionally accepts only the read-oriented Server Agent permission set for OAuth. Write, deploy, restart, registry-management, recovery-run, and rollback-run permissions remain unavailable through this OAuth profile.

## Required configuration

Keep OAuth disabled while preparing the service:

~~~env
SERVER_AGENT_OAUTH_ENABLED=false
SERVER_AGENT_PUBLIC_BASE_URL=
SERVER_AGENT_OAUTH_OWNER_SECRET=
SERVER_AGENT_OAUTH_PRINCIPAL_ID=chatgpt-oauth
SERVER_AGENT_OAUTH_PROJECT_SCOPES=example-project
SERVER_AGENT_OAUTH_PERMISSIONS=project:read,files:read,git:read
SERVER_AGENT_OAUTH_SCOPE=mcp:read
SERVER_AGENT_OAUTH_ALLOWED_REDIRECT_ORIGINS=https://chatgpt.com
SERVER_AGENT_OAUTH_ACCESS_TOKEN_TTL_SECONDS=3600
SERVER_AGENT_OAUTH_REFRESH_TOKEN_TTL_SECONDS=2592000
~~~

For an approved remote hostname, set the canonical origin, for example:

~~~env
SERVER_AGENT_OAUTH_ENABLED=true
SERVER_AGENT_PUBLIC_BASE_URL=https://agent.example.com
SERVER_AGENT_OAUTH_OWNER_SECRET=<generate-a-new-32+-character-secret-on-the-server>
SERVER_AGENT_OAUTH_PROJECT_SCOPES=project-a
SERVER_AGENT_OAUTH_PERMISSIONS=project:read,files:read,git:read
~~~

Do not commit the owner secret. Generate it on the server and keep `/etc/server-agent/server-agent.env` root-owned with mode `0600`.

When using a temporary `trycloudflare.com` hostname, the public base URL must exactly match that temporary origin. A new Quick Tunnel URL therefore requires updating the base URL and restarting Server Agent.

## OAuth endpoints

When enabled, Server Agent publishes:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/mcp` (compatibility path)
- `GET /.well-known/oauth-authorization-server`
- `POST /oauth/register`
- `GET /oauth/authorize`
- `POST /oauth/authorize`
- `POST /oauth/token`

Unauthenticated MCP requests return HTTP `401` plus a `WWW-Authenticate` challenge pointing at the protected-resource metadata document. `tools/list` definitions also advertise an OAuth2 security scheme. Authorization-server metadata advertises both `mcp:read` and `offline_access`; the latter enables refresh-token issuance for long-lived ChatGPT connectivity.

## ChatGPT connection flow

1. ChatGPT discovers the protected-resource metadata.
2. ChatGPT reads authorization-server metadata and registers a public DCR client.
3. ChatGPT starts Authorization Code + PKCE (`S256`) and opens the Server Agent authorization page.
4. The operator enters the Server Agent owner authorization secret.
5. Server Agent sends a one-time authorization code to the exact registered ChatGPT redirect URI and includes `iss`.
6. ChatGPT requests `offline_access`, exchanges the code for a short-lived access token plus a rotating refresh token, and can renew the connection without reauthorization.
7. ChatGPT calls `/mcp` with the access token. The normal Server Agent project scope, project capability, file sandbox, sensitive-file policy, and audit layers still apply.

## Operational notes

OAuth does not grant a project permission that the project registration itself does not have. For example, if `marbo3a` is registered with only `project:read`, `files:read`, and `git:read`, the OAuth principal cannot write files even if a future configuration error attempted to request broader access.

Keep the existing bootstrap bearer credential until OAuth has been tested end to end. Once a separate recovery/admin credential is safely stored, bootstrap credential rotation/removal can be handled independently of OAuth.

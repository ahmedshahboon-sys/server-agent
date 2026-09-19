# Cloudflare remote MCP preparation

This document is preparation for the later installation phase. Phase 5 does **not** create a tunnel, change DNS, install cloudflared on production, or create Cloudflare Access policies.

Official references used for the installation plan:

- Cloudflare Tunnel run-as-a-service: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/as-a-service/linux/
- Cloudflare Access service tokens: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/

## Intended topology

```text
ChatGPT / approved MCP client
        |
        | HTTPS + outer access control
        v
Cloudflare Access / Tunnel
        |
        | local origin only
        v
http://127.0.0.1:8765/mcp
        |
        v
Server Agent authentication + project/tool authorization
```

The tunnel is transport, not Server Agent authorization. Keep Server Agent bearer authentication enabled even when Cloudflare Access protects the hostname. Server Agent does not trust Cloudflare identity headers as a replacement for its own credential store.

## Later tunnel setup principles

1. Keep Server Agent bound to `127.0.0.1`; do not expose port 8765 directly to the Internet.
2. Create a dedicated hostname such as `agent.example.com` only during the installation phase.
3. Configure the tunnel origin to `http://127.0.0.1:8765` and the public MCP path to `/mcp`.
4. Run `cloudflared` as its own managed service according to Cloudflare's current Linux service documentation.
5. Store tunnel credentials outside the repository with restrictive filesystem permissions.
6. Put Cloudflare Access in front of the hostname. Do not use a public bypass policy merely to simplify MCP setup.
7. Confirm the actual MCP client can present the selected Access authentication method before enabling remote use.
8. Keep Server Agent's independent `Authorization: Bearer ...` credential and project/tool authorization in place.

## Cloudflare Access service tokens

Cloudflare service tokens use a Client ID and Client Secret. For clients that support custom Access headers, Cloudflare documents `CF-Access-Client-Id` and `CF-Access-Client-Secret`. These values are secrets and must never be committed, stored in Server Agent SQLite, or pasted into project registration metadata.

Client capabilities differ. If the MCP client cannot provide the Access headers or supported Access/OAuth flow required by the chosen policy, resolve that integration during installation using a currently supported Cloudflare/client mechanism. Do not work around the limitation by exposing Server Agent publicly or disabling its bearer authentication.

## Request layers

A remote MCP request may therefore have two independent authentication layers:

- outer Cloudflare Access authentication, managed by Cloudflare;
- inner Server Agent `Authorization: Bearer <agent token>` authentication.

After authentication, every Server Agent tool call still passes tool permission, project scope, registered-project capability, sandbox, output bounds, rate limits, and operation-specific safety checks. Different approved clients should receive different Server Agent principal/credential ids so audit and revocation remain independent even when they share the same outer Cloudflare Access application.

## Access identity handling

Cloudflare Access headers/JWTs may be useful at the outer edge, but Group 5 intentionally does not add a second parser that blindly trusts forwarded `CF-*` headers. Only the Cloudflare layer validates Cloudflare credentials. The local Server Agent still authenticates `Authorization: Bearer ...` against its own hashed credential store. This avoids turning a spoofable forwarded header into an inner authorization bypass.

## No automatic infrastructure changes

`install/install.sh` intentionally contains no Cloudflare, DNS, Nginx, firewall, Docker, or project-registration commands. Those infrastructure steps remain explicit later actions after the local Agent has passed health and safety validation.

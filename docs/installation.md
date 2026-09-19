# Installation package

Phase 5 prepares installation artifacts only. Nothing in this repository automatically SSHs to a server, changes DNS, edits Nginx, changes firewall rules, registers production projects, or enables Cloudflare.

## Target

- Ubuntu/Linux host
- Node.js 22 or newer
- npm
- systemd
- expected source checkout: `/opt/server-agent`
- dedicated service account: `server-agent`
- state: `/var/lib/server-agent`
- environment file: `/etc/server-agent/server-agent.env`

The paths are configurable for an intentional installation, but the installer refuses relative paths and refuses to run Server Agent as root.

## Later installation workflow

Do these steps only after an explicit installation command from the operator:

1. Inspect the target host, RAM, Node.js, disk, running services, and the intended project paths.
2. Clone the reviewed `main` commit into `/opt/server-agent`.
3. Run `sudo /opt/server-agent/install/install.sh` without `--enable` first.
4. Review `/etc/server-agent/server-agent.env`, replace `SERVER_AGENT_MCP_BEARER_TOKEN=CHANGE_ME_...` with a new high-entropy bootstrap secret generated on the server, and keep the non-secret `SERVER_AGENT_MCP_CREDENTIAL_ID` unique.
5. Review `/etc/server-agent/allowed-services`. Leave it empty until an exact registered project service needs status/restart/log access; then add only that exact `.service` unit.
6. Keep `SERVER_AGENT_MCP_HOST=127.0.0.1` and `SERVER_AGENT_MCP_ALLOW_PUBLIC_BIND=false` when Cloudflare Tunnel or another local reverse transport is used.
7. Start with read-only project permissions and register the first production project explicitly after local verification.
8. Only after configuration review, run `sudo /opt/server-agent/install/install.sh --enable`. The host helper starts before the main Agent.
9. Verify both `server-agent-host-helper.service` and `server-agent.service`, local MCP discovery, memory use, project sandbox behavior, and deny behavior for a service not in the host allowlist before adding remote transport.

The installer is idempotent: an existing environment file is preserved, the service user/group are reused, source/project trees are never copied or recursively deleted, and the service is not started unless `--enable` is supplied.

## systemd safety model

`install/systemd/server-agent.service.template` uses a non-root account, `NoNewPrivileges`, `ProtectHome=true`, `UMask=0077`, kernel/control-group protections, an empty capability bounding set, bounded file descriptors/tasks, and memory accounting/limits. The installer refuses runtime/source paths owned by the service user and group/world-writable runtime/source paths so the Agent cannot replace its own executable code.

Host-level service operations use `server-agent-host-helper.service`, a separate root service with no IP networking and a Unix socket under `/run/server-agent-host`. The helper is root-capable only for exact service units listed in root-owned `/etc/server-agent/allowed-services`, and only for `status`, `restart`, and bounded journal reads. The main Agent receives no sudo rule and no `systemd-journal` group membership.

`ProtectHome=true` means projects intended for Server Agent writes should live outside `/home`. If an intentional project location needs a different systemd filesystem policy, review and narrow that policy explicitly instead of disabling hardening globally.

## Credential bootstrap and rotation

The environment bearer is a bootstrap mechanism, not the long-term credential database. On first startup, Server Agent stores only its SHA-256 hash plus principal/credential metadata in SQLite. After at least one usable credential exists, the bootstrap bearer can be removed from the environment.

Build first, then use the local-only CLI when needed:

```bash
cd /opt/server-agent
npm run auth:admin -- list
npm run auth:admin -- create --principal operator-b --credential operator-b-2026-09 --scopes project-a --permissions project:read,files:read
npm run auth:admin -- rotate --credential bootstrap-chatgpt --new-credential chatgpt-2026-10
npm run auth:admin -- revoke --credential chatgpt-2026-09
```

`create` and `rotate` print the new bearer once. Store it outside Git. Rotation uses a new credential id and revokes the old credential; reusing an existing credential id with different token material fails closed.

## Environment and secrets

The repository contains examples only. Real bearer tokens, Cloudflare credentials, database credentials, SSH keys, and project secrets must remain outside Git. Server Agent project records hold environment-variable references rather than secret values.

The default example principal is deliberately read-oriented. Increase remote permissions only when a specific operational workflow requires them, and keep each registered project's capability list equally narrow.

## Uninstall helper

`sudo /opt/server-agent/install/uninstall.sh` stops/disables both Server Agent systemd units and removes only their unit files. It intentionally preserves:

- `/etc/server-agent`
- `/var/lib/server-agent`
- `/opt/server-agent`
- every registered project tree

Destructive cleanup is a separate manual decision after backup and review.

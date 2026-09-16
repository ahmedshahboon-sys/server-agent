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
4. Review `/etc/server-agent/server-agent.env` and replace `SERVER_AGENT_MCP_BEARER_TOKEN=CHANGE_ME_...` with a new high-entropy secret generated on the server.
5. Keep `SERVER_AGENT_MCP_HOST=127.0.0.1` and `SERVER_AGENT_MCP_ALLOW_PUBLIC_BIND=false` when Cloudflare Tunnel or another local reverse transport is used.
6. Start with read-only project permissions and register the first production project explicitly after local verification.
7. Only after configuration review, run `sudo /opt/server-agent/install/install.sh --enable`.
8. Verify `systemctl status server-agent.service`, journal logs, local MCP discovery, memory use, and project sandbox behavior before adding remote transport.

The installer is idempotent: an existing environment file is preserved, the service user/group are reused, source/project trees are never copied or recursively deleted, and the service is not started unless `--enable` is supplied.

## systemd safety model

`install/systemd/server-agent.service.template` uses a non-root account, `NoNewPrivileges`, a restrictive umask, kernel/control-group protections, an empty capability bounding set, bounded file descriptors/tasks, and memory accounting/limits. It deliberately does not grant sudo or a blanket privilege escalation path.

`ProtectHome=read-only` means projects that require writes should normally live outside `/home`. If an intentional project location needs a different systemd filesystem policy, review and narrow that policy explicitly instead of disabling hardening globally.

Service restart tools may require a narrowly scoped host authorization policy for the `server-agent` user. The installation package does not create such a policy automatically; until one is deliberately added, leave `service:restart` out of the remote principal/project permissions.

## Environment and secrets

The repository contains examples only. Real bearer tokens, Cloudflare credentials, database credentials, SSH keys, and project secrets must remain outside Git. Server Agent project records hold environment-variable references rather than secret values.

The default example principal is deliberately read-oriented. Increase remote permissions only when a specific operational workflow requires them, and keep each registered project's capability list equally narrow.

## Uninstall helper

`sudo /opt/server-agent/install/uninstall.sh` stops/disables the service and removes the systemd unit only. It intentionally preserves:

- `/etc/server-agent`
- `/var/lib/server-agent`
- `/opt/server-agent`
- every registered project tree

Destructive cleanup is a separate manual decision after backup and review.

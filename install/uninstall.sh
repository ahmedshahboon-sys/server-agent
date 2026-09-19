#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this uninstall helper as root." >&2
  exit 1
fi
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Server Agent uninstall helper supports Linux only." >&2
  exit 1
fi

UNIT_FILE="/etc/systemd/system/server-agent.service"
HOST_HELPER_UNIT_FILE="/etc/systemd/system/server-agent-host-helper.service"

if systemctl list-unit-files server-agent.service >/dev/null 2>&1; then
  systemctl disable --now server-agent.service || true
fi
if systemctl list-unit-files server-agent-host-helper.service >/dev/null 2>&1; then
  systemctl disable --now server-agent-host-helper.service || true
fi
rm -f "${UNIT_FILE}" "${HOST_HELPER_UNIT_FILE}"
systemctl daemon-reload
systemctl reset-failed server-agent.service >/dev/null 2>&1 || true
systemctl reset-failed server-agent-host-helper.service >/dev/null 2>&1 || true

cat <<'EOF'
Server Agent service units removed.
Preserved intentionally:
  - /etc/server-agent (configuration/secrets and host service allowlist)
  - /var/lib/server-agent (SQLite state/job/auth/audit evidence)
  - /opt/server-agent (source/build)
  - every registered project tree
Delete preserved data only after making an explicit backup and reviewing it manually.
EOF

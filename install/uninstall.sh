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
if systemctl list-unit-files server-agent.service >/dev/null 2>&1; then
  systemctl disable --now server-agent.service || true
fi
if [[ -f "${UNIT_FILE}" ]]; then
  rm -f "${UNIT_FILE}"
  systemctl daemon-reload
  systemctl reset-failed server-agent.service >/dev/null 2>&1 || true
fi

cat <<'EOF'
Server Agent service unit removed.
Preserved intentionally:
  - /etc/server-agent (configuration/secrets)
  - /var/lib/server-agent (SQLite state/job evidence)
  - /opt/server-agent (source/build)
  - every registered project tree
Delete preserved data only after making an explicit backup and reviewing it manually.
EOF

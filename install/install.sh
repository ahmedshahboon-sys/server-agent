#!/usr/bin/env bash
set -euo pipefail

ENABLE_SERVICE=0
case "${1:-}" in
  "") ;;
  --enable) ENABLE_SERVICE=1 ;;
  *) echo "Usage: $0 [--enable]" >&2; exit 64 ;;
esac

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Server Agent installation package supports Linux only." >&2
  exit 1
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
INSTALL_DIR="${SERVER_AGENT_INSTALL_DIR:-/opt/server-agent}"
AGENT_USER="${SERVER_AGENT_USER:-server-agent}"
AGENT_GROUP="${SERVER_AGENT_GROUP:-server-agent}"
CONFIG_DIR="${SERVER_AGENT_CONFIG_DIR:-/etc/server-agent}"
ENV_FILE="${SERVER_AGENT_ENV_FILE:-${CONFIG_DIR}/server-agent.env}"
DATA_DIR="${SERVER_AGENT_DATA_DIR_INSTALL:-/var/lib/server-agent}"
ALLOWLIST_FILE="${CONFIG_DIR}/allowed-services"
UNIT_FILE="/etc/systemd/system/server-agent.service"
HOST_HELPER_UNIT_FILE="/etc/systemd/system/server-agent-host-helper.service"

if [[ "${INSTALL_DIR}" != /* || "${CONFIG_DIR}" != /* || "${ENV_FILE}" != /* || "${DATA_DIR}" != /* ]]; then
  echo "Install, config, environment, and data paths must be absolute." >&2
  exit 1
fi
if [[ ! "${AGENT_USER}" =~ ^[a-z_][a-z0-9_-]{0,31}$ || ! "${AGENT_GROUP}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
  echo "Invalid service user or group name." >&2
  exit 1
fi
if [[ "${AGENT_USER}" == "root" || "${AGENT_GROUP}" == "root" ]]; then
  echo "Server Agent must not run as root." >&2
  exit 1
fi

NORMALIZED_INSTALL_DIR="$(realpath -m "${INSTALL_DIR}")"
if [[ "${SOURCE_DIR}" != "${NORMALIZED_INSTALL_DIR}" ]]; then
  echo "Repository must already be cloned at ${NORMALIZED_INSTALL_DIR}. This installer never copies or deletes project/source trees." >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"
if [[ -z "${NODE_BIN}" || -z "${NPM_BIN}" ]]; then
  echo "Node.js >=22 and npm are required before installation." >&2
  exit 1
fi
NODE_MAJOR="$("${NODE_BIN}" -p "Number(process.versions.node.split('.')[0])")"
if ! [[ "${NODE_MAJOR}" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 22 )); then
  echo "Node.js >=22 is required; found $("${NODE_BIN}" --version)." >&2
  exit 1
fi

if ! getent group "${AGENT_GROUP}" >/dev/null 2>&1; then
  groupadd --system "${AGENT_GROUP}"
fi
if ! id "${AGENT_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${AGENT_GROUP}" --home-dir "${DATA_DIR}" --no-create-home --shell /usr/sbin/nologin "${AGENT_USER}"
fi
if [[ "$(id -u "${AGENT_USER}")" -eq 0 ]]; then
  echo "Refusing to use a UID 0 service account." >&2
  exit 1
fi

install -d -m 0750 -o "${AGENT_USER}" -g "${AGENT_GROUP}" "${DATA_DIR}"
install -d -m 0750 -o root -g root "${CONFIG_DIR}"
if [[ ! -e "${ENV_FILE}" ]]; then
  install -m 0600 -o root -g root "${SOURCE_DIR}/install/server-agent.env.example" "${ENV_FILE}"
  echo "Created ${ENV_FILE} from the public example. Replace the bootstrap bearer-token placeholder before first enable."
else
  chmod 0600 "${ENV_FILE}"
  chown root:root "${ENV_FILE}"
  echo "Preserving existing ${ENV_FILE}."
fi
if [[ ! -e "${ALLOWLIST_FILE}" ]]; then
  install -m 0640 -o root -g root "${SOURCE_DIR}/install/host/allowed-services.example" "${ALLOWLIST_FILE}"
  echo "Created empty host service allowlist at ${ALLOWLIST_FILE}."
else
  chmod 0640 "${ALLOWLIST_FILE}"
  chown root:root "${ALLOWLIST_FILE}"
  echo "Preserving existing ${ALLOWLIST_FILE}."
fi

cd "${SOURCE_DIR}"
"${NPM_BIN}" ci --ignore-scripts --no-audit --no-fund
"${NPM_BIN}" run validate
"${NPM_BIN}" prune --omit=dev --ignore-scripts --no-audit --no-fund

if find "${SOURCE_DIR}" -xdev -user "${AGENT_USER}" -print -quit | grep -q .; then
  echo "Refusing installation: Server Agent runtime/source contains paths owned by service user ${AGENT_USER}." >&2
  exit 1
fi
if find "${SOURCE_DIR}" -xdev -group "${AGENT_GROUP}" -perm -0020 -print -quit | grep -q .; then
  echo "Refusing installation: Server Agent runtime/source contains group-writable paths for ${AGENT_GROUP}." >&2
  exit 1
fi
if find "${SOURCE_DIR}" -xdev -perm -0002 -print -quit | grep -q .; then
  echo "Refusing installation: Server Agent runtime/source contains world-writable paths." >&2
  exit 1
fi

escape_sed() { printf '%s' "$1" | sed 's/[&|]/\\&/g'; }
TMP_UNIT="$(mktemp)"
TMP_HELPER_UNIT="$(mktemp)"
trap 'rm -f "${TMP_UNIT}" "${TMP_HELPER_UNIT}"' EXIT
sed \
  -e "s|@@USER@@|$(escape_sed "${AGENT_USER}")|g" \
  -e "s|@@GROUP@@|$(escape_sed "${AGENT_GROUP}")|g" \
  -e "s|@@INSTALL_DIR@@|$(escape_sed "${SOURCE_DIR}")|g" \
  -e "s|@@ENV_FILE@@|$(escape_sed "${ENV_FILE}")|g" \
  -e "s|@@NODE_BIN@@|$(escape_sed "${NODE_BIN}")|g" \
  "${SOURCE_DIR}/install/systemd/server-agent.service.template" > "${TMP_UNIT}"
sed \
  -e "s|@@GROUP@@|$(escape_sed "${AGENT_GROUP}")|g" \
  -e "s|@@INSTALL_DIR@@|$(escape_sed "${SOURCE_DIR}")|g" \
  -e "s|@@ALLOWLIST@@|$(escape_sed "${ALLOWLIST_FILE}")|g" \
  -e "s|@@NODE_BIN@@|$(escape_sed "${NODE_BIN}")|g" \
  "${SOURCE_DIR}/install/systemd/server-agent-host-helper.service.template" > "${TMP_HELPER_UNIT}"
install -m 0644 -o root -g root "${TMP_UNIT}" "${UNIT_FILE}"
install -m 0644 -o root -g root "${TMP_HELPER_UNIT}" "${HOST_HELPER_UNIT_FILE}"
systemctl daemon-reload

if (( ENABLE_SERVICE == 1 )); then
  if grep -Eq '^SERVER_AGENT_MCP_BEARER_TOKEN=CHANGE_ME_WITH_32_PLUS_RANDOM_CHARACTERS$' "${ENV_FILE}"; then
    echo "Refusing first enable while the example bearer-token placeholder remains in ${ENV_FILE}." >&2
    exit 1
  fi
  systemctl enable --now server-agent-host-helper.service
  systemctl --no-pager --full status server-agent-host-helper.service
  systemctl enable --now server-agent.service
  systemctl --no-pager --full status server-agent.service
else
  echo "Installation package prepared successfully. Services were NOT started or enabled."
  echo "Review ${ENV_FILE} and ${ALLOWLIST_FILE}, then explicitly run: sudo ${SOURCE_DIR}/install/install.sh --enable"
fi

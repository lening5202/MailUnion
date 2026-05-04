#!/usr/bin/env bash
set -euo pipefail

REPO="${MAILUNION_REPO:-lening5202/MailUnion}"
BRANCH="${MAILUNION_BRANCH:-main}"
INSTALL_DIR="${MAILUNION_INSTALL_DIR:-/opt/mailunion}"
PORT="${PORT:-52080}"
SERVICE_NAME="${MAILUNION_SERVICE_NAME:-mailunion}"
SERVICE_USER="${MAILUNION_SERVICE_USER:-mailunion}"

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "sudo is required when not running as root." >&2
    exit 1
  fi
  SUDO="sudo"
fi

run_root() {
  if [ -n "${SUDO}" ]; then
    sudo "$@"
  else
    "$@"
  fi
}

node_major() {
  if ! command -v node >/dev/null 2>&1; then
    echo 0
    return
  fi
  node -v | sed -E 's/^v?([0-9]+).*/\1/'
}

ensure_package() {
  local package_name="$1"
  if command -v apt-get >/dev/null 2>&1; then
    run_root apt-get update
    run_root apt-get install -y "${package_name}"
  elif command -v dnf >/dev/null 2>&1; then
    run_root dnf install -y "${package_name}"
  elif command -v yum >/dev/null 2>&1; then
    run_root yum install -y "${package_name}"
  else
    echo "Unsupported package manager. Please install ${package_name} manually." >&2
    exit 1
  fi
}

ensure_tools() {
  command -v curl >/dev/null 2>&1 || ensure_package curl
  command -v unzip >/dev/null 2>&1 || ensure_package unzip
  command -v tar >/dev/null 2>&1 || ensure_package tar
}

install_node() {
  echo "Installing Node.js 22..."
  if command -v apt-get >/dev/null 2>&1; then
    run_root apt-get update
    run_root apt-get install -y ca-certificates curl gnupg
    curl -fsSL https://deb.nodesource.com/setup_22.x | run_root bash -
    run_root apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | run_root bash -
    run_root dnf install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | run_root bash -
    run_root yum install -y nodejs
  else
    echo "Unsupported package manager. Please install Node.js 22+ manually." >&2
    exit 1
  fi
}

new_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  if grep -qE "^${key}=" "${file}"; then
    run_root sed -i "s#^${key}=.*#${key}=${value}#" "${file}"
  else
    echo "${key}=${value}" | run_root tee -a "${file}" >/dev/null
  fi
}

wait_health() {
  local i
  for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

echo "Mail Union one-click installer"
echo "Repository : ${REPO} (${BRANCH})"
echo "Install dir: ${INSTALL_DIR}"
echo "Port       : ${PORT}"

ensure_tools

if [ "$(node_major)" -lt 22 ]; then
  install_node
fi

if [ "$(node_major)" -lt 22 ]; then
  echo "Node.js 22 or newer is required." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

ARCHIVE="${TMP_DIR}/source.zip"
DOWNLOAD_URL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.zip"
echo "Downloading ${DOWNLOAD_URL}"
curl -fL "${DOWNLOAD_URL}" -o "${ARCHIVE}"
unzip -q "${ARCHIVE}" -d "${TMP_DIR}"
SOURCE_DIR="$(find "${TMP_DIR}" -mindepth 1 -maxdepth 1 -type d ! -name '__MACOSX' | head -n 1)"
if [ -z "${SOURCE_DIR}" ]; then
  echo "Downloaded archive does not contain project files." >&2
  exit 1
fi

run_root mkdir -p "${INSTALL_DIR}"
tar \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='runtime' \
  --exclude='.runtime' \
  --exclude='logs' \
  --exclude='.codex-logs' \
  --exclude='.source-backups' \
  --exclude='.tmp-edge-profile' \
  -C "${SOURCE_DIR}" -cf - . | run_root tar -C "${INSTALL_DIR}" -xf -

run_root mkdir -p "${INSTALL_DIR}/data" "${INSTALL_DIR}/runtime/files" "${INSTALL_DIR}/logs"

if [ ! -f "${INSTALL_DIR}/.env" ]; then
  run_root cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
fi

set_env_value "${INSTALL_DIR}/.env" "PORT" "${PORT}"
if grep -qE '^APP_SECRET=(change-this-before-production)?\s*$' "${INSTALL_DIR}/.env"; then
  set_env_value "${INSTALL_DIR}/.env" "APP_SECRET" "$(new_secret)"
fi

echo "Installing npm dependencies..."
if ! (cd "${INSTALL_DIR}" && run_root npm ci --omit=dev); then
  (cd "${INSTALL_DIR}" && run_root npm install --omit=dev)
fi

if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  run_root useradd --system --home-dir "${INSTALL_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
fi
run_root chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

NODE_BIN="$(command -v node)"
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
  cat <<EOF | run_root tee "${SERVICE_FILE}" >/dev/null
[Unit]
Description=Mail Union
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${NODE_BIN} src/server.js
Restart=always
RestartSec=5
User=${SERVICE_USER}
Group=${SERVICE_USER}

[Install]
WantedBy=multi-user.target
EOF
  run_root systemctl daemon-reload
  run_root systemctl enable --now "${SERVICE_NAME}"
  echo "systemd service enabled: ${SERVICE_NAME}"
else
  echo "systemd was not detected; falling back to nohup start without system boot service." >&2
  if [ -n "${SUDO}" ]; then
    sudo -u "${SERVICE_USER}" bash "${INSTALL_DIR}/scripts/start-linux.sh"
  else
    su -s /bin/bash -c "bash '${INSTALL_DIR}/scripts/start-linux.sh'" "${SERVICE_USER}"
  fi
fi

if command -v ufw >/dev/null 2>&1 && run_root ufw status | grep -qi active; then
  run_root ufw allow "${PORT}/tcp" || true
fi

if command -v firewall-cmd >/dev/null 2>&1 && run_root firewall-cmd --state >/dev/null 2>&1; then
  run_root firewall-cmd --permanent --add-port="${PORT}/tcp" || true
  run_root firewall-cmd --reload || true
fi

if wait_health; then
  echo "Mail Union is running: http://127.0.0.1:${PORT}"
else
  echo "Mail Union was installed, but health check did not respond yet. Check logs in ${INSTALL_DIR}/logs." >&2
fi

echo "Default administrator: admin / admin"

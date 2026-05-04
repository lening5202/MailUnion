#!/usr/bin/env bash
set -euo pipefail

REPO="${MAILUNION_REPO:-lening5202/MailUnion}"
BRANCH="${MAILUNION_BRANCH:-main}"
IMAGE="${MAILUNION_IMAGE:-ghcr.io/lening5202/mailunion:latest}"
INSTALL_DIR="${MAILUNION_DOCKER_DIR:-/opt/mailunion-docker}"
PORT="${PORT:-52080}"
CONTAINER_NAME="${MAILUNION_CONTAINER_NAME:-mailunion}"

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

install_docker() {
  echo "Installing Docker..."
  if command -v apt-get >/dev/null 2>&1; then
    run_root apt-get update
    run_root apt-get install -y ca-certificates curl gnupg
    run_root install -m 0755 -d /etc/apt/keyrings
    . /etc/os-release
    local docker_repo_os="${ID}"
    if [ "${ID}" = "debian" ]; then
      docker_repo_os="debian"
    else
      docker_repo_os="ubuntu"
    fi
    run_root rm -f /etc/apt/keyrings/docker.gpg
    curl -fsSL "https://download.docker.com/linux/${docker_repo_os}/gpg" | run_root gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    run_root chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${docker_repo_os} ${VERSION_CODENAME} stable" \
      | run_root tee /etc/apt/sources.list.d/docker.list >/dev/null
    run_root apt-get update
    run_root apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  elif command -v dnf >/dev/null 2>&1; then
    run_root dnf install -y dnf-plugins-core
    run_root dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    run_root dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  elif command -v yum >/dev/null 2>&1; then
    run_root yum install -y yum-utils
    run_root yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    run_root yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    echo "Unsupported package manager. Please install Docker manually." >&2
    exit 1
  fi
}

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    install_docker
  fi

  run_root systemctl enable --now docker >/dev/null 2>&1 || true

  if ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose plugin is required." >&2
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

write_env() {
  local env_file="${INSTALL_DIR}/.env"
  if [ -f "${env_file}" ]; then
    return
  fi

  run_root tee "${env_file}" >/dev/null <<EOF
PORT=${PORT}
APP_SECRET=$(new_secret)
SYNC_INTERVAL_MS=5000
INITIAL_SYNC_LIMIT=30
SESSION_TTL_DAYS=7

ADMIN_NAME=admin
ADMIN_USERNAME=admin
ADMIN_EMAIL=admin@mail-union.local
ADMIN_PASSWORD=admin

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT_ID=common
EOF
}

write_compose() {
  run_root tee "${INSTALL_DIR}/compose.yaml" >/dev/null <<EOF
name: mailunion

services:
  mailunion:
    image: ${IMAGE}
    container_name: ${CONTAINER_NAME}
    restart: unless-stopped
    env_file:
      - .env
    environment:
      NODE_ENV: production
      PORT: 52080
    ports:
      - "${PORT}:52080"
    volumes:
      - ./data:/app/data
      - ./runtime:/app/runtime
      - ./logs:/app/logs
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:52080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 30s
      retries: 3
EOF
}

wait_health() {
  local i
  for i in $(seq 1 45); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

echo "Mail Union Docker installer"
echo "Repository : ${REPO} (${BRANCH})"
echo "Image      : ${IMAGE}"
echo "Install dir: ${INSTALL_DIR}"
echo "Port       : ${PORT}"

command -v curl >/dev/null 2>&1 || ensure_package curl
ensure_docker

run_root mkdir -p "${INSTALL_DIR}/data" "${INSTALL_DIR}/runtime/files" "${INSTALL_DIR}/logs"
run_root chown -R 1000:1000 "${INSTALL_DIR}/data" "${INSTALL_DIR}/runtime" "${INSTALL_DIR}/logs" || true
write_env
write_compose

cd "${INSTALL_DIR}"
run_root docker compose pull
run_root docker compose up -d

if wait_health; then
  echo "Mail Union Docker is running: http://127.0.0.1:${PORT}"
else
  echo "Mail Union container started, but health check did not pass yet." >&2
  echo "Check logs with: cd ${INSTALL_DIR} && sudo docker compose logs -f" >&2
fi

#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:-${MAILUNION_IMAGE:-lening5202/mailunion:latest}}"
PLATFORMS="${MAILUNION_PLATFORMS:-linux/amd64,linux/arm64}"
PUSH="${MAILUNION_PUSH:-1}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not in PATH." >&2
  exit 1
fi

if [ "${PUSH}" = "1" ]; then
  docker buildx build --platform "${PLATFORMS}" -t "${IMAGE}" --push .
else
  docker build -t "${IMAGE}" .
fi

echo "Docker image ready: ${IMAGE}"

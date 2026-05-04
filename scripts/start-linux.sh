#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${MAILUNION_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PORT="${PORT:-52080}"

if command -v curl >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "Mail Union already listens on port ${PORT}."
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Run scripts/install-linux.sh first." >&2
  exit 1
fi

mkdir -p "${APP_DIR}/logs"
cd "${APP_DIR}"
nohup node src/server.js >> "logs/server-${PORT}.out.log" 2>> "logs/server-${PORT}.err.log" &
echo "Mail Union is starting at http://127.0.0.1:${PORT}"

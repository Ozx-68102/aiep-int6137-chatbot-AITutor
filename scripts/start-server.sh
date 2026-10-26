#!/usr/bin/env bash
# Start the backend on 127.0.0.1:3001.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root/server"

if ! command -v uv >/dev/null 2>&1; then
  echo "start-server: uv is not installed" >&2
  exit 1
fi

exec uv run uvicorn server.app:app --host 127.0.0.1 --port 3001

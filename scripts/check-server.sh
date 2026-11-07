#!/usr/bin/env bash
# Run the backend checks: ruff lint, ruff format and basedpyright types.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root/server"

if ! command -v uv >/dev/null 2>&1; then
  echo "check-server: uv is not installed" >&2
  exit 1
fi

uv run ruff check .
uv run ruff format --check .
uv run basedpyright

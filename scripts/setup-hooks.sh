#!/usr/bin/env bash
# Enable repo Git hooks (Mac/Linux and Windows Git Bash).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if [[ ! -d .githooks ]]; then
  echo "setup-hooks: missing .githooks/ at repo root" >&2
  exit 1
fi

git config core.hooksPath .githooks

shopt -s nullglob
for hook in .githooks/*; do
  [[ -f "$hook" ]] || continue
  chmod +x "$hook"
done

echo "setup-hooks: core.hooksPath=$(git config core.hooksPath)"
echo "setup-hooks: enabled executable hooks in .githooks/"

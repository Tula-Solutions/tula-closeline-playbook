#!/usr/bin/env bash
# Fail if a file synced from the hub was edited or removed in this repo. Part of `bun run verify`.
# The hub itself is checked against shared/ by `scripts/sync-shared.sh --check`.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"

if [ ! -f .claude/shared.lock ]; then
  echo "shared-check: .claude/shared.lock is missing — run scripts/sync-shared.sh from the hub" >&2
  exit 1
fi

if ! grep -v '^#' .claude/shared.lock | shasum -a 256 --check --quiet - >&2; then
  echo "shared-check: a synced file differs from the hub's copy." >&2
  echo "  Edit it in tula-closeline/shared and run scripts/sync-shared.sh; never edit it here." >&2
  exit 1
fi

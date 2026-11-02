#!/usr/bin/env bash
# Run the backend test suite against a throwaway DB. Never uses production data.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d /tmp/cm-tests-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
export CM_DB="$TMP/cm.db"
export CM_DATA_DIR="$TMP"
cd "$ROOT"
python3 -m unittest discover -s backend/tests "$@"

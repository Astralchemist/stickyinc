#!/usr/bin/env bash
# StickyInc MCP smoke test. Kept for muscle memory; smoke.mjs does the work
# (and uses a throwaway HOME, so your real task list is never touched).
set -euo pipefail
cd "$(dirname "$0")"
exec node smoke.mjs "$@"

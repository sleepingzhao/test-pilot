#!/usr/bin/env bash
# V0.3 GitLab job example: regression against staging URL (no LLM on happy path).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE_URL="${TESTPILOT_BASE_URL:-http://127.0.0.1:4173}"
API="${TESTPILOT_API:-http://127.0.0.1:8787}"

cd "$ROOT"
pnpm build

if ! curl -sf "$BASE_URL" >/dev/null; then
  echo "Target not reachable: $BASE_URL" >&2
  exit 1
fi

if curl -sf "$API/api/health" >/dev/null 2>&1; then
  curl -sf -X POST "$API/api/projects/default/runs" \
    -H 'content-type: application/json' \
    -d '{}' | tee /tmp/testpilot-batch.json
  echo
  echo "Use Web Console or poll batch job for full results."
else
  echo "API not running; falling back to CLI single smoke test"
  pnpm cli run examples/demo-webapp/tests/demo-users-smoke.json \
    --base-url "$BASE_URL" -o /tmp/testpilot-run.json
  cat /tmp/testpilot-run.json
fi

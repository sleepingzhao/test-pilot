#!/usr/bin/env bash
# GitLab CI / cron: run approved tests via management API; exit non-zero on any failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE_URL="${TESTPILOT_BASE_URL:-http://127.0.0.1:4173}"
API="${TESTPILOT_API:-http://127.0.0.1:8787}"
DEMO_PID=""
API_PID=""

cleanup() {
  for pid in "$API_PID" "$DEMO_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

cd "$ROOT"
pnpm install --frozen-lockfile
pnpm build

if [[ "$BASE_URL" == "http://127.0.0.1:4173"* ]] || [[ "$BASE_URL" == "http://localhost:4173"* ]]; then
  pnpm --filter @testpilot/demo-webapp start &
  DEMO_PID=$!
fi

pnpm --filter @testpilot/test-management dev &
API_PID=$!

for _ in $(seq 1 90); do
  curl -sf "$BASE_URL" >/dev/null 2>&1 && curl -sf "$API/api/health" >/dev/null 2>&1 && break
  sleep 1
done

if ! curl -sf "$BASE_URL" >/dev/null; then
  echo "Target not reachable: $BASE_URL" >&2
  exit 1
fi
if ! curl -sf "$API/api/health" >/dev/null 2>&1; then
  echo "API failed to start: $API" >&2
  exit 1
fi

JOB_JSON="$(curl -sf -X POST "$API/api/projects/default/runs" -H 'content-type: application/json' -d '{}')"
JOB_ID="$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(j.jobId||'');" "$JOB_JSON")"

if [[ -z "$JOB_ID" ]]; then
  echo "$JOB_JSON"
  node -e "const j=JSON.parse(process.argv[1]); const rs=j.runs||[]; const bad=rs.filter(r=>r.status!=='passed'); if(bad.length) process.exit(1);" "$JOB_JSON"
  exit 0
fi

for _ in $(seq 1 600); do
  STATUS_JSON="$(curl -sf "$API/api/batch-runs/$JOB_ID")"
  STATUS="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).status||'')" "$STATUS_JSON")"
  if [[ "$STATUS" == "completed" ]]; then
    node -e "
      const j=JSON.parse(require('fs').readFileSync(0,'utf8'));
      const ok=j.runs.filter(r=>r.status==='passed').length;
      console.log('passed', ok, '/', j.runs.length);
      if (j.runs.some(r=>r.status!=='passed')) process.exit(1);
    " <<<"$STATUS_JSON"
    exit 0
  fi
  if [[ "$STATUS" == "failed" ]]; then
    echo "$STATUS_JSON" >&2
    exit 1
  fi
  sleep 2
done

echo "Batch job timed out: $JOB_ID" >&2
exit 1

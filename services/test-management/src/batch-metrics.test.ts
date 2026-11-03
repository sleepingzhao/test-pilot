import assert from "node:assert/strict";
import test from "node:test";
import { groupRunsIntoBatches } from "./batch-metrics.js";
import type { StoredRun } from "./store.js";

function runAt(iso: string, status: "passed" | "failed" = "passed", ms = 100): StoredRun {
  return {
    runId: iso,
    testId: "t",
    testVersion: 1,
    testTitle: "t",
    projectId: "default",
    status,
    startedAt: iso,
    completedAt: iso,
    metrics: { durationMs: ms, llmTokensUsed: 0, attemptCount: 1 },
    steps: [],
    assertions: [],
    artifacts: { runId: iso, dir: "", artifacts: [] },
  };
}

test("groupRunsIntoBatches clusters runs within 120s", () => {
  const batches = groupRunsIntoBatches([
    runAt("2026-01-01T10:00:00.000Z"),
    runAt("2026-01-01T10:00:30.000Z"),
    runAt("2026-01-01T09:50:00.000Z"),
  ]);
  assert.equal(batches.length, 2);
  assert.equal(batches[0]!.total, 2);
  assert.equal(batches[1]!.total, 1);
});

test("groupRunsIntoBatches counts pass rate per batch", () => {
  const batches = groupRunsIntoBatches([
    runAt("2026-01-01T10:00:00.000Z", "passed"),
    runAt("2026-01-01T10:00:10.000Z", "failed"),
  ]);
  const b = batches[0]!;
  assert.equal(b.passed, 1);
  assert.equal(b.total, 2);
});

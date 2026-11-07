import assert from "node:assert/strict";
import test from "node:test";
import { computeRegressionBaseline } from "./regression-baseline.js";
import type { StoredBatch, StoredRun } from "./store.js";

function run(id: string, status: StoredRun["status"], batchId: string): StoredRun {
  return {
    runId: id,
    testId: "t",
    testTitle: "t",
    testVersion: 1,
    projectId: "default",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status,
    batchId,
    steps: [],
    assertions: [],
    artifacts: { runId: id, dir: `artifacts/runs/${id}`, artifacts: [] },
    metrics: { durationMs: 100, llmTokensUsed: 0, attemptCount: 1 },
  };
}

test("computeRegressionBaseline needs three completed batches", () => {
  const batches: StoredBatch[] = [
    {
      batchId: "b1",
      startedAt: "2026-01-03T00:00:00.000Z",
      total: 2,
      passed: 2,
      status: "completed",
      runIds: ["r1", "r2"],
    },
    {
      batchId: "b2",
      startedAt: "2026-01-02T00:00:00.000Z",
      total: 2,
      passed: 2,
      status: "completed",
      runIds: ["r3", "r4"],
    },
  ];
  const map = new Map<string, StoredRun>();
  assert.equal(computeRegressionBaseline(batches, map), null);
});

test("aggregate pass and flake targets (positive)", () => {
  const batches: StoredBatch[] = [3, 2, 1].map((n) => ({
    batchId: `b${n}`,
    startedAt: `2026-01-0${n}T00:00:00.000Z`,
    total: 10,
    passed: 10,
    status: "completed" as const,
    runIds: Array.from({ length: 10 }, (_, i) => `r${n}_${i}`),
  }));
  const map = new Map<string, StoredRun>();
  for (const b of batches) {
    for (const id of b.runIds) map.set(id, run(id, "passed", b.batchId));
  }
  const report = computeRegressionBaseline(batches, map);
  assert.ok(report);
  assert.equal(report.aggregate.passRate, 1);
  assert.equal(report.aggregate.meetsPassTarget, true);
  assert.equal(report.aggregate.meetsFlakeTarget, true);
});

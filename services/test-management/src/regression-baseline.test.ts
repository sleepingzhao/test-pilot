import assert from "node:assert/strict";
import test from "node:test";
import { computeRegressionBaseline } from "./regression-baseline.js";
import type { StoredBatch, StoredRun } from "./store.js";

function run(id: string, status: StoredRun["status"], batchId: string, failureKind?: string): StoredRun {
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
    metrics: { durationMs: 100, llmTokensUsed: 0, attemptCount: 1, failureKind },
  };
}

function batch(n: number, opts: Partial<StoredBatch> = {}): StoredBatch {
  return {
    batchId: `b${n}`,
    startedAt: `2026-01-0${n}T00:00:00.000Z`,
    total: 10,
    passed: 10,
    status: "completed",
    runIds: Array.from({ length: 10 }, (_, i) => `r${n}_${i}`),
    mode: "full",
    repeatCount: 1,
    ...opts,
  };
}

test("computeRegressionBaseline needs three completed full batches", () => {
  assert.equal(computeRegressionBaseline([batch(2), batch(1)], new Map()), null);
  const selected = [batch(3, { mode: "selected" }), batch(2, { mode: "selected" }), batch(1, { mode: "selected" })];
  assert.equal(computeRegressionBaseline(selected, new Map()), null);
});

test("aggregate pass and flake targets (positive)", () => {
  const batches = [batch(3), batch(2), batch(1)];
  const map = new Map<string, StoredRun>();
  for (const b of batches) {
    for (const id of b.runIds) map.set(id, run(id, "passed", b.batchId));
  }
  const report = computeRegressionBaseline(batches, map);
  assert.ok(report);
  assert.equal(report.aggregate.passRate, 1);
  assert.equal(report.aggregate.flakeRate, 0);
  assert.equal(report.aggregate.meetsPassTarget, true);
  assert.equal(report.aggregate.meetsFlakeTarget, true);
});

test("missing runs count as not passed (negative)", () => {
  const batches = [batch(3, { passed: 8 }), batch(2, { passed: 8 }), batch(1, { passed: 8 })];
  const map = new Map<string, StoredRun>();
  for (const b of batches) {
    for (const id of b.runIds.slice(0, 8)) map.set(id, run(id, "passed", b.batchId));
  }
  const report = computeRegressionBaseline(batches, map);
  assert.ok(report);
  assert.equal(report.aggregate.totalRuns, 30);
  assert.equal(report.aggregate.passedRuns, 24);
  assert.equal(report.aggregate.passRate, 0.8);
  assert.equal(report.aggregate.meetsPassTarget, false);
});

test("cross-batch pass/fail instability fails the flake target (negative)", () => {
  const batches = [batch(3), batch(2), batch(1)];
  const map = new Map<string, StoredRun>();
  for (const b of batches) {
    for (const id of b.runIds) {
      const flaky = b.batchId === "b3" && ["_0", "_1", "_2"].some((suffix) => id.endsWith(suffix));
      map.set(id, run(id, flaky ? "failed" : "passed", b.batchId, flaky ? "ENVIRONMENT" : undefined));
    }
  }
  const report = computeRegressionBaseline(batches, map);
  assert.ok(report);
  assert.ok(report.aggregate.flakeRate > 0);
  assert.equal(report.aggregate.meetsFlakeTarget, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { groupExplicitBatches } from "./batch-metrics.js";
import type { StoredRun } from "./store.js";

function run(
  partial: Partial<StoredRun> & Pick<StoredRun, "runId" | "startedAt">,
): StoredRun {
  return {
    testId: "t",
    testVersion: 1,
    testTitle: "t",
    projectId: "default",
    status: "passed",
    completedAt: partial.startedAt,
    metrics: { durationMs: 100, llmTokensUsed: 0, attemptCount: 1 },
    steps: [],
    assertions: [],
    artifacts: { runId: partial.runId, dir: "", artifacts: [] },
    ...partial,
  };
}

test("groupExplicitBatches groups by batchId and ignores ad-hoc runs", () => {
  const batches = groupExplicitBatches([
    run({ runId: "r1", startedAt: "2026-01-01T10:00:00.000Z", batchId: "batch_a", batchStartedAt: "2026-01-01T10:00:00.000Z" }),
    run({ runId: "r2", startedAt: "2026-01-01T10:00:30.000Z", batchId: "batch_a", batchStartedAt: "2026-01-01T10:00:00.000Z" }),
    run({ runId: "r3", startedAt: "2026-01-01T10:00:20.000Z" }),
    run({ runId: "r4", startedAt: "2026-01-01T09:00:00.000Z", batchId: "batch_b", batchStartedAt: "2026-01-01T09:00:00.000Z" }),
  ]);
  assert.equal(batches.length, 2);
  assert.equal(batches[0]!.batchId, "batch_a");
  assert.equal(batches[0]!.total, 2);
  assert.equal(batches[1]!.batchId, "batch_b");
});

test("groupExplicitBatches counts pass rate per batch", () => {
  const batches = groupExplicitBatches([
    run({
      runId: "r1",
      startedAt: "2026-01-01T10:00:00.000Z",
      status: "passed",
      batchId: "batch_x",
      batchStartedAt: "2026-01-01T10:00:00.000Z",
    }),
    run({
      runId: "r2",
      startedAt: "2026-01-01T10:00:10.000Z",
      status: "failed",
      batchId: "batch_x",
      batchStartedAt: "2026-01-01T10:00:00.000Z",
    }),
  ]);
  const b = batches[0]!;
  assert.equal(b.passed, 1);
  assert.equal(b.total, 2);
});

test("batch duration is wall clock, not the sum of per-run durations", () => {
  const batches = groupExplicitBatches([
    run({
      runId: "r1",
      startedAt: "2026-01-01T10:00:00.000Z",
      completedAt: "2026-01-01T10:00:30.000Z",
      batchId: "batch_w",
      batchStartedAt: "2026-01-01T10:00:00.000Z",
      metrics: { durationMs: 30_000, llmTokensUsed: 0, attemptCount: 1 },
    }),
    run({
      runId: "r2",
      startedAt: "2026-01-01T10:00:01.000Z",
      completedAt: "2026-01-01T10:00:30.000Z",
      batchId: "batch_w",
      batchStartedAt: "2026-01-01T10:00:00.000Z",
      metrics: { durationMs: 29_000, llmTokensUsed: 0, attemptCount: 1 },
    }),
  ]);
  assert.equal(batches[0]!.durationMs, 30_000);
});

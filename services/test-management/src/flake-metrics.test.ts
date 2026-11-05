import assert from "node:assert/strict";
import test from "node:test";
import { computeFlakeStats } from "./flake-metrics.js";
import type { StoredRun } from "./store.js";

function run(partial: Partial<StoredRun> & Pick<StoredRun, "status">): StoredRun {
  return {
    runId: "r1",
    testId: "t1",
    testTitle: "t",
    testVersion: 1,
    projectId: "default",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    steps: [],
    assertions: [],
    artifacts: { runId: "r1", dir: "artifacts/r1", artifacts: [] },
    metrics: { durationMs: 1, llmTokensUsed: 0, attemptCount: 1 },
    ...partial,
  };
}

test("computeFlakeStats counts recoveries after retry", () => {
  const stats = computeFlakeStats([
    run({ status: "passed", metrics: { durationMs: 1, attemptCount: 2, flakeRecovery: true } }),
    run({ status: "passed", metrics: { durationMs: 1, attemptCount: 1 } }),
    run({ status: "failed", metrics: { durationMs: 1, attemptCount: 2 } }),
  ]);
  assert.equal(stats.multiAttemptRuns, 2);
  assert.equal(stats.flakeRecoveryCount, 1);
  assert.equal(stats.flakeRecoveryRate, 1 / 3);
});

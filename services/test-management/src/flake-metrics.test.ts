import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFlakeMetricsReport,
  computeFlakeStats,
  isAssertionFailureRun,
  isFlakeScoredRun,
  normalizeRepeatCount,
} from "./flake-metrics.js";
import type { StoredRun } from "./store.js";

function run(partial: Partial<StoredRun> & Pick<StoredRun, "status">): StoredRun {
  return {
    runId: partial.runId ?? "r1",
    testId: partial.testId ?? "t1",
    testTitle: partial.testTitle ?? "t",
    testVersion: 1,
    projectId: "default",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    steps: [],
    assertions: partial.assertions ?? [],
    artifacts: { runId: partial.runId ?? "r1", dir: "artifacts/r1", artifacts: [] },
    metrics: { durationMs: 1, llmTokensUsed: 0, attemptCount: 1, ...partial.metrics },
    ...partial,
  };
}

test("computeFlakeStats counts recoveries after retry", () => {
  const stats = computeFlakeStats([
    run({ status: "passed", metrics: { durationMs: 1, attemptCount: 2, flakeRecovery: true } }),
    run({ status: "passed", metrics: { durationMs: 1, attemptCount: 1 } }),
    run({ status: "failed", metrics: { durationMs: 1, attemptCount: 2, failureKind: "ENVIRONMENT" } }),
  ]);
  assert.equal(stats.multiAttemptRuns, 2);
  assert.equal(stats.flakeRecoveryCount, 1);
  assert.equal(stats.flakeRecoveryRate, 1 / 3);
});

test("assertion failures (oracle and product defect) are excluded from flake scoring (negative)", () => {
  const oracleFail = run({
    status: "failed",
    metrics: { durationMs: 1, attemptCount: 3, failureKind: "ASSERTION_ORACLE" },
  });
  const productFail = run({
    status: "failed",
    metrics: { durationMs: 1, attemptCount: 2, failureKind: "PRODUCT_DEFECT" },
  });
  const failedAssertion = run({
    status: "failed",
    assertions: [{ assertionId: "a", passed: false, errorKind: "PRODUCT_DEFECT" }],
  });
  for (const item of [oracleFail, productFail, failedAssertion]) {
    assert.equal(isAssertionFailureRun(item), true);
    assert.equal(isFlakeScoredRun(item), false);
  }
  const stats = computeFlakeStats([oracleFail, productFail, failedAssertion]);
  assert.equal(stats.runCount, 0);
  assert.equal(stats.multiAttemptRuns, 0);
});

test("deterministic environment failure stays in flake pool but is not a recovery (negative)", () => {
  const stats = computeFlakeStats([
    run({
      status: "failed",
      metrics: { durationMs: 1, attemptCount: 1, failureKind: "ENVIRONMENT" },
    }),
  ]);
  assert.equal(stats.runCount, 1);
  assert.equal(stats.flakeRecoveryCount, 0);
});

test("per-test flake rate reflects retry recovery (positive)", () => {
  const report = buildFlakeMetricsReport([
    run({
      testId: "demo-a",
      testTitle: "A",
      status: "passed",
      metrics: { durationMs: 1, attemptCount: 2, flakeRecovery: true },
    }),
    run({ testId: "demo-a", testTitle: "A", status: "passed", metrics: { durationMs: 1, attemptCount: 1 } }),
  ]);
  assert.equal(report.byTest.length, 1);
  assert.equal(report.byTest[0]!.flakeRecoveryCount, 1);
  assert.equal(report.byTest[0]!.flakeRate, 0.5);
});

test("repeat instability marks flake when pass and error mix (positive)", () => {
  const report = buildFlakeMetricsReport([
    run({ testId: "demo-b", status: "passed", runId: "r1" }),
    run({ testId: "demo-b", status: "error", runId: "r2", metrics: { durationMs: 1, failureKind: "ENVIRONMENT" } }),
    run({ testId: "demo-b", status: "passed", runId: "r3" }),
  ]);
  assert.equal(report.byTest[0]!.flakeRate, 1 / 3);
  assert.equal(report.flakeRate, 1 / 3);
});

test("failureKinds counts failed runs only and excludes trial", () => {
  const report = buildFlakeMetricsReport([
    run({ status: "passed", trial: true }),
    run({ status: "failed", metrics: { durationMs: 1, failureKind: "ENVIRONMENT" } }),
    run({ status: "passed" }),
  ]);
  const kinds = Object.fromEntries(report.failureKinds.map((k) => [k.kind, k.count]));
  assert.equal(kinds.PASSED, undefined);
  assert.equal(kinds.ENVIRONMENT, 1);
  assert.equal(report.excludedAssertionFailures, 0);
});

test("normalizeRepeatCount clamps to 1..5 and accepts numeric strings", () => {
  assert.equal(normalizeRepeatCount(undefined), 1);
  assert.equal(normalizeRepeatCount(3), 3);
  assert.equal(normalizeRepeatCount("3"), 3);
  assert.equal(normalizeRepeatCount(99), 5);
  assert.equal(normalizeRepeatCount(0), 1);
  assert.equal(normalizeRepeatCount("abc"), 1);
});

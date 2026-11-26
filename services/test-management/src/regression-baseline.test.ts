import assert from "node:assert/strict";
import test from "node:test";
import {
  computeRegressionBaseline,
  computeRegressionBaselines,
  manualMeasurementForSuite,
} from "./regression-baseline.js";
import type { StoredBatch, StoredRun } from "./store.js";

function round(
  n: number,
  batchPatch: Partial<StoredBatch> = {},
  runPatch: (testId: string) => Partial<StoredRun> = () => ({}),
) {
  const date = `2026-01-0${n}`;
  const batch: StoredBatch = {
    batchId: `batch_${n}`,
    startedAt: `${date}T00:00:00.000Z`,
    completedAt: `${date}T00:00:01.200Z`,
    total: 2,
    passed: 2,
    status: "completed",
    runIds: [`run_${n}_a`, `run_${n}_b`],
    mode: "selected",
    repeatCount: 1,
    maxParallel: 2,
    ...batchPatch,
  };
  const runs: StoredRun[] = batch.runIds.map((runId) => {
    const testId = runId.split("_").at(-1)!;
    return {
      runId, testId, testTitle: testId, testVersion: 1, projectId: "default", status: "passed",
      startedAt: batch.startedAt, completedAt: batch.completedAt!, batchId: batch.batchId,
      steps: [], assertions: [], artifacts: { runId, dir: "", artifacts: [] },
      metrics: { durationMs: 900, attemptCount: 1, llmTokensUsed: 0 },
      comparisonKey: `environment-a:version-1:${testId}`,
      ...runPatch(testId),
    };
  });
  return { batch, runs };
}

function input(rounds: ReturnType<typeof round>[]) {
  return [
    rounds.map(item => item.batch),
    new Map(rounds.flatMap(item => item.runs.map(run => [run.runId, run]))),
  ] as const;
}

test("three selected rounds of the same cases form a wall-clock baseline regardless of input order", () => {
  const third = round(3);
  third.batch.runIds.reverse();
  const [batches, runs] = input([round(2), third, round(1), round(4)]);
  const report = computeRegressionBaseline(batches, runs);
  assert.ok(report);
  assert.deepEqual(report.testIds, ["a", "b"]);
  assert.deepEqual(report.batches.map(batch => batch.batchId), ["batch_4", "batch_3", "batch_2"]);
  assert.deepEqual(report.batches.map(batch => batch.durationMs), [1200, 1200, 1200]);
  assert.equal(report.aggregate.durationMs, 3600);
  assert.equal(report.aggregate.passRate, 1);
  assert.equal(report.aggregate.meetsPassTarget, true);
  assert.equal(report.aggregate.meetsFlakeTarget, true);
});

test("actual environment, case version, project, suite membership and parallel settings separate rounds", () => {
  const matches = [round(1), round(2), round(3)];
  const environments = round(4, {}, id => ({ comparisonKey: `environment-b:version-1:${id}` }));
  const version = round(5, {}, id => id === "a" ? { comparisonKey: "environment-a:version-2:a" } : {});
  const project = round(6, {}, () => ({ projectId: "different" }));
  const membership = round(7, { runIds: ["run_7_a", "run_7_c"] });
  const parallel = round(8, { maxParallel: 1 });
  const legacyParallel = round(9, { maxParallel: undefined });
  const [batches, runs] = input([...matches, environments, version, project, membership, parallel, legacyParallel]);
  const reports = computeRegressionBaselines(batches, runs);
  assert.deepEqual(reports.map(report => report.batchCount), [1, 1, 1, 1, 1, 1, 3]);
  assert.equal(new Set(reports.map(report => report.suiteKey)).size, 7);
  assert.equal(reports[0]!.maxParallel, undefined);
  assert.equal(reports[1]!.maxParallel, 1);
  assert.equal(computeRegressionBaseline(batches, runs)?.suiteKey, reports.at(-1)?.suiteKey);
});

test("partial, legacy unidentifiable, draft and trial rounds do not fill a comparable baseline", () => {
  const incomplete = round(3);
  incomplete.runs.pop();
  const [batches, runs] = input([
    round(1), round(2), incomplete,
    round(4, {}, () => ({ comparisonKey: undefined })),
    round(5, { mode: "include-draft" }),
    round(6, {}, () => ({ trial: true })),
    round(7, { repeatCount: 2 }),
    round(8, {}, () => ({ batchId: "other-batch" })),
    round(9, {}, () => ({ testId: "duplicate" })),
  ]);
  assert.deepEqual(computeRegressionBaselines(batches, runs).map(report => report.batchCount), [2]);
  assert.equal(computeRegressionBaseline(batches, runs), null);
});

test("recorded failures remain in the denominator and product failures do not inflate flake", () => {
  const [batches, runs] = input([
    round(1, { mode: "full" }), round(2, { mode: "full" }),
    round(3, { mode: "full" }, id => id === "a" ? {
      status: "failed", metrics: { durationMs: 200, attemptCount: 1, llmTokensUsed: 0, failureKind: "PRODUCT_DEFECT" },
    } : {}),
  ]);
  const report = computeRegressionBaseline(batches, runs)!;
  assert.equal(report.aggregate.passedRuns, 5);
  assert.equal(report.aggregate.totalRuns, 6);
  assert.equal(report.aggregate.meetsPassTarget, false);
  assert.equal(report.aggregate.flakeRate, 0);
  runs.get("run_3_a")!.metrics.failureKind = "ENVIRONMENT";
  assert.equal(computeRegressionBaseline(batches, runs)?.aggregate.meetsFlakeTarget, false);
});

test("manual savings use exact scope and require measured manual, triage and residual work", () => {
  const record = { suiteKey: "same-scope", manualRegressionMinutes: 20, reviewAndTriageMinutes: 4, remainingManualMinutes: 0 };
  assert.deepEqual(manualMeasurementForSuite("same-scope", [record]), {
    manualRegressionMinutes: 20, reviewAndTriageMinutes: 4, remainingManualMinutes: 0, minutesSaved: 16,
  });
  assert.equal(manualMeasurementForSuite("same-scope", [{ ...record, remainingManualMinutes: 22 }]).minutesSaved, -6);
  assert.equal(manualMeasurementForSuite("another-scope", [record]).manualRegressionMinutes, null);
  for (const remainingManualMinutes of [undefined, NaN, -1, "3"]) {
    assert.equal(manualMeasurementForSuite("same-scope", [{ ...record, remainingManualMinutes }]).minutesSaved, null);
  }
  assert.equal(manualMeasurementForSuite("same-scope", [record, record]).minutesSaved, null);
});

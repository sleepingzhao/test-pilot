import type { StoredRun } from "./store.js";

export type FlakeStats = {
  runCount: number;
  multiAttemptRuns: number;
  flakeRecoveryCount: number;
  flakeRecoveryRate: number;
};

export function isAssertionFailureRun(run: StoredRun): boolean {
  if (run.metrics?.failureKind === "ASSERTION_ORACLE") return true;
  return run.assertions?.some((a) => !a.passed && a.errorKind === "ASSERTION_ORACLE") ?? false;
}

/** Runs that may participate in flake / retry statistics (excludes trial and assertion-oracle failures). */
export function isFlakeScoredRun(run: StoredRun): boolean {
  if (run.trial) return false;
  if (run.status === "failed" && isAssertionFailureRun(run)) return false;
  return true;
}

export function computeFlakeStats(runs: StoredRun[]): FlakeStats {
  const scored = runs.filter(isFlakeScoredRun);
  const runCount = scored.length;
  let multiAttemptRuns = 0;
  let flakeRecoveryCount = 0;
  for (const run of scored) {
    const attempts = run.metrics?.attemptCount ?? 1;
    if (attempts > 1) multiAttemptRuns += 1;
    if (run.status === "passed" && (run.metrics?.flakeRecovery || attempts > 1)) {
      flakeRecoveryCount += 1;
    }
  }
  return {
    runCount,
    multiAttemptRuns,
    flakeRecoveryCount,
    flakeRecoveryRate: runCount ? flakeRecoveryCount / runCount : 0,
  };
}

export type FlakeByTestRow = {
  testId: string;
  testTitle: string;
  runCount: number;
  passedCount: number;
  failedCount: number;
  multiAttemptRuns: number;
  flakeRecoveryCount: number;
  /** Share of scored runs that passed after retry or show pass/fail instability across repeats. */
  flakeRate: number;
};

export type FailureKindRow = {
  kind: string;
  count: number;
};

export type FlakeMetricsReport = FlakeStats & {
  excludedAssertionFailures: number;
  byTest: FlakeByTestRow[];
  failureKinds: FailureKindRow[];
};

function instabilityAcrossRepeats(runs: StoredRun[]): boolean {
  const passed = runs.some((r) => r.status === "passed");
  const failed = runs.some((r) => r.status === "failed");
  return passed && failed;
}

export function buildFlakeMetricsReport(runs: StoredRun[]): FlakeMetricsReport {
  const excludedAssertionFailures = runs.filter((r) => !r.trial && isAssertionFailureRun(r)).length;
  const global = computeFlakeStats(runs);

  const byTestMap = new Map<string, StoredRun[]>();
  for (const run of runs) {
    if (!isFlakeScoredRun(run)) continue;
    const list = byTestMap.get(run.testId) ?? [];
    list.push(run);
    byTestMap.set(run.testId, list);
  }

  const byTest: FlakeByTestRow[] = [];
  for (const [testId, testRuns] of byTestMap) {
    const passedCount = testRuns.filter((r) => r.status === "passed").length;
    const failedCount = testRuns.length - passedCount;
    let multiAttemptRuns = 0;
    let flakeRecoveryCount = 0;
    let flakyRunCount = 0;
    for (const run of testRuns) {
      const attempts = run.metrics?.attemptCount ?? 1;
      if (attempts > 1) multiAttemptRuns += 1;
      if (run.status === "passed" && (run.metrics?.flakeRecovery || attempts > 1)) {
        flakeRecoveryCount += 1;
        flakyRunCount += 1;
      }
    }
    if (instabilityAcrossRepeats(testRuns)) {
      flakyRunCount = Math.max(flakyRunCount, 1);
    }
    const title = testRuns[0]?.testTitle ?? testId;
    byTest.push({
      testId,
      testTitle: title,
      runCount: testRuns.length,
      passedCount,
      failedCount,
      multiAttemptRuns,
      flakeRecoveryCount,
      flakeRate: testRuns.length ? flakyRunCount / testRuns.length : 0,
    });
  }
  byTest.sort((a, b) => b.flakeRate - a.flakeRate || a.testTitle.localeCompare(b.testTitle));

  const kindCounts = new Map<string, number>();
  for (const run of runs) {
    if (run.trial) continue;
    const kind = run.metrics?.failureKind ?? (run.status === "passed" ? "PASSED" : "UNKNOWN");
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
  const failureKinds = [...kindCounts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

  return {
    ...global,
    excludedAssertionFailures,
    byTest,
    failureKinds,
  };
}

export function normalizeRepeatCount(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 1;
  return Math.min(5, Math.max(1, n));
}

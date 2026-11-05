import type { StoredRun } from "./store.js";

export type FlakeStats = {
  runCount: number;
  multiAttemptRuns: number;
  flakeRecoveryCount: number;
  flakeRecoveryRate: number;
};

export function computeFlakeStats(runs: StoredRun[]): FlakeStats {
  const runCount = runs.length;
  let multiAttemptRuns = 0;
  let flakeRecoveryCount = 0;
  for (const run of runs) {
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

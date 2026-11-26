import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoredBatch, StoredRun } from "./store.js";
import { metricsFromBatchRecord, type BatchMetrics } from "./batch-metrics.js";
import { buildFlakeMetricsReport } from "./flake-metrics.js";

export type RegressionBaselineReport = {
  updatedAt: string;
  suiteKey: string;
  testIds: string[];
  maxParallel?: number;
  batchCount: number;
  batches: Array<BatchMetrics & { passRate: number; artifactBytesTotal?: number }>;
  aggregate: {
    totalRuns: number;
    passedRuns: number;
    passRate: number;
    flakeRate: number;
    flakeRecoveryRate: number;
    durationMs: number;
    meetsPassTarget: boolean;
    meetsFlakeTarget: boolean;
  };
  targets: { passRateMin: number; flakeRateMax: number };
};

export const REGRESSION_TARGETS = { passRateMin: 0.95, flakeRateMax: 0.05 };
const BASELINE_ROUNDS = 3;

type CompletedRound = { batch: StoredBatch; runs: StoredRun[] };

function comparableRound(batch: StoredBatch, runsById: Map<string, StoredRun>): CompletedRound | undefined {
  if (batch.status !== "completed" || (batch.mode !== "selected" && batch.mode !== "full") ||
      (batch.repeatCount ?? 1) !== 1 || batch.total <= 0 || batch.runIds.length !== batch.total) return;
  const start = Date.parse(batch.startedAt);
  const end = Date.parse(batch.completedAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;

  const runs: StoredRun[] = [];
  const testIds = new Set<string>();
  for (const id of batch.runIds) {
    const run = runsById.get(id);
    if (!run?.comparisonKey || run.trial || run.batchId !== batch.batchId ||
        run.projectId !== (runs[0]?.projectId ?? run.projectId) || testIds.has(run.testId)) return;
    runs.push(run);
    testIds.add(run.testId);
  }
  runs.sort((a, b) => a.testId.localeCompare(b.testId));
  return { batch, runs };
}

function summarizeSuite(suiteKey: string, rounds: CompletedRound[], targets: RegressionBaselineReport["targets"]): RegressionBaselineReport {
  const first = rounds[0]!;
  const batches = rounds.map(({ batch, runs }) => {
    const metrics = metricsFromBatchRecord(batch);
    const passed = runs.filter(run => run.status === "passed").length;
    return { ...metrics, passed, passRate: passed / metrics.total, artifactBytesTotal: batch.artifactBytesTotal };
  });
  const totalRuns = batches.reduce((sum, batch) => sum + batch.total, 0);
  const passedRuns = batches.reduce((sum, batch) => sum + batch.passed, 0);
  const passRate = passedRuns / totalRuns;
  const flake = buildFlakeMetricsReport(rounds.flatMap(round => round.runs));
  return {
    updatedAt: new Date().toISOString(),
    suiteKey,
    testIds: first.runs.map(run => run.testId),
    maxParallel: first.batch.maxParallel,
    batchCount: batches.length,
    batches,
    aggregate: {
      totalRuns,
      passedRuns,
      passRate,
      flakeRate: flake.flakeRate,
      flakeRecoveryRate: flake.flakeRecoveryRate,
      durationMs: batches.reduce((sum, batch) => sum + batch.durationMs, 0),
      meetsPassTarget: passRate >= targets.passRateMin,
      meetsFlakeTarget: flake.flakeRate < targets.flakeRateMax,
    },
    targets,
  };
}

export function computeRegressionBaselines(
  batches: StoredBatch[],
  runsById: Map<string, StoredRun>,
  targets = REGRESSION_TARGETS,
): RegressionBaselineReport[] {
  const grouped = new Map<string, CompletedRound[]>();
  const seen = new Set<string>();
  for (const batch of [...batches].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
    if (seen.has(batch.batchId)) continue;
    seen.add(batch.batchId);
    const round = comparableRound(batch, runsById);
    if (!round) continue;
    const suiteKey = createHash("sha256").update(JSON.stringify({
      projectId: round.runs[0]!.projectId,
      maxParallel: batch.maxParallel ?? null,
      tests: round.runs.map(run => [run.testId, run.comparisonKey]),
    })).digest("hex");
    const previous = grouped.get(suiteKey) ?? [];
    if (previous.length < BASELINE_ROUNDS) previous.push(round);
    grouped.set(suiteKey, previous);
  }
  return [...grouped].map(([key, rounds]) => summarizeSuite(key, rounds, targets));
}

export function computeRegressionBaseline(
  batches: StoredBatch[],
  runsById: Map<string, StoredRun>,
  targets = REGRESSION_TARGETS,
): RegressionBaselineReport | null {
  return computeRegressionBaselines(batches, runsById, targets).find(suite => suite.batchCount === BASELINE_ROUNDS) ?? null;
}

function measuredMinutes(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function manualMeasurementForSuite(suiteKey: string, records: unknown) {
  type Measurement = { suiteKey?: unknown; manualRegressionMinutes?: unknown; reviewAndTriageMinutes?: unknown; remainingManualMinutes?: unknown };
  const matches = Array.isArray(records)
    ? records.filter((entry): entry is Measurement => entry && typeof entry === "object" && entry.suiteKey === suiteKey)
    : [];
  const measurement = matches.length === 1 ? matches[0] : undefined;
  const manualRegressionMinutes = measuredMinutes(measurement?.manualRegressionMinutes);
  const reviewAndTriageMinutes = measuredMinutes(measurement?.reviewAndTriageMinutes);
  const remainingManualMinutes = measuredMinutes(measurement?.remainingManualMinutes);
  const minutesSaved = manualRegressionMinutes !== null && reviewAndTriageMinutes !== null && remainingManualMinutes !== null
    ? Math.round((manualRegressionMinutes - reviewAndTriageMinutes - remainingManualMinutes) * 10) / 10
    : null;
  return { manualRegressionMinutes, reviewAndTriageMinutes, remainingManualMinutes, minutesSaved };
}

export async function writeRegressionBaselineReport(dataRoot: string, report: RegressionBaselineReport | null) {
  const dir = join(dataRoot, "reports");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "regression-baseline.json");
  await writeFile(path, `${JSON.stringify(report ?? { updatedAt: new Date().toISOString(), batchCount: 0 }, null, 2)}\n`);
  return path;
}

export async function readRegressionBaselineReport(dataRoot: string): Promise<RegressionBaselineReport | null> {
  try {
    const raw = await readFile(join(dataRoot, "reports", "regression-baseline.json"), "utf8");
    const report = JSON.parse(raw) as RegressionBaselineReport;
    return report.suiteKey && report.batchCount === BASELINE_ROUNDS ? report : null;
  } catch {
    return null;
  }
}

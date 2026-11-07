import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoredBatch, StoredRun } from "./store.js";
import { buildFlakeMetricsReport } from "./flake-metrics.js";

export type RegressionBaselineReport = {
  updatedAt: string;
  batchCount: number;
  batches: Array<{
    batchId: string;
    startedAt: string;
    completedAt?: string;
    total: number;
    passed: number;
    passRate: number;
    durationMs: number;
    artifactBytesTotal?: number;
  }>;
  aggregate: {
    totalRuns: number;
    passedRuns: number;
    passRate: number;
    flakeRecoveryRate: number;
    durationMs: number;
    meetsPassTarget: boolean;
    meetsFlakeTarget: boolean;
  };
  targets: { passRateMin: number; flakeRateMax: number };
};

const DEFAULT_TARGETS = { passRateMin: 0.95, flakeRateMax: 0.05 };

export function computeRegressionBaseline(
  batches: StoredBatch[],
  runsById: Map<string, StoredRun>,
  targets = DEFAULT_TARGETS,
): RegressionBaselineReport | null {
  const completed = batches
    .filter((b) => b.status === "completed" && b.runIds.length > 0)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 3);
  if (completed.length < 3) return null;

  const batchRows = completed.map((b) => {
    const runs = b.runIds.map((id) => runsById.get(id)).filter((r): r is StoredRun => !!r && !r.trial);
    const durationMs = runs.reduce((s, r) => s + (r.metrics?.durationMs ?? 0), 0);
    return {
      batchId: b.batchId,
      startedAt: b.startedAt,
      completedAt: b.completedAt,
      total: b.total,
      passed: b.passed,
      passRate: b.total ? b.passed / b.total : 0,
      durationMs,
      artifactBytesTotal: b.artifactBytesTotal,
    };
  });

  const allRuns: StoredRun[] = [];
  for (const b of completed) {
    for (const id of b.runIds) {
      const r = runsById.get(id);
      if (r && !r.trial) allRuns.push(r);
    }
  }
  const passedRuns = allRuns.filter((r) => r.status === "passed").length;
  const passRate = allRuns.length ? passedRuns / allRuns.length : 0;
  const flake = buildFlakeMetricsReport(allRuns);
  const durationMs = batchRows.reduce((s, b) => s + b.durationMs, 0);

  return {
    updatedAt: new Date().toISOString(),
    batchCount: 3,
    batches: batchRows,
    aggregate: {
      totalRuns: allRuns.length,
      passedRuns,
      passRate,
      flakeRecoveryRate: flake.flakeRecoveryRate,
      durationMs,
      meetsPassTarget: passRate >= targets.passRateMin,
      meetsFlakeTarget: flake.flakeRecoveryRate < targets.flakeRateMax,
    },
    targets,
  };
}

export async function writeRegressionBaselineReport(dataRoot: string, report: RegressionBaselineReport | null) {
  const dir = join(dataRoot, "reports");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "regression-baseline.json");
  if (!report) {
    await writeFile(path, `${JSON.stringify({ updatedAt: new Date().toISOString(), batchCount: 0 }, null, 2)}\n`);
    return path;
  }
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

export async function readRegressionBaselineReport(dataRoot: string): Promise<RegressionBaselineReport | null> {
  try {
    const raw = await readFile(join(dataRoot, "reports", "regression-baseline.json"), "utf8");
    const parsed = JSON.parse(raw) as RegressionBaselineReport & { batchCount?: number };
    if (!parsed.batchCount || parsed.batchCount < 3) return null;
    return parsed as RegressionBaselineReport;
  } catch {
    return null;
  }
}

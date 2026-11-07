import type { StoredBatch, StoredRun } from "./store.js";

export type BatchMetrics = {
  batchId: string;
  startedAt: string;
  completedAt: string;
  total: number;
  passed: number;
  /** Wall-clock duration of the batch (not the sum of per-run durations). */
  durationMs: number;
};

function wallClockMs(startedAt: string, completedAt: string): number {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function metricsFromRuns(batchId: string, items: StoredRun[]): BatchMetrics {
  const passed = items.filter((r) => r.status === "passed").length;
  const startedAt =
    items[0]?.batchStartedAt ??
    items.reduce((a, r) => (r.startedAt < a ? r.startedAt : a), items[0]!.startedAt);
  const completedAt = items.reduce((a, r) => (r.completedAt > a ? r.completedAt : a), items[0]!.completedAt);
  return {
    batchId,
    startedAt,
    completedAt,
    total: items.length,
    passed,
    durationMs: wallClockMs(startedAt, completedAt),
  };
}

export function metricsFromBatchRecord(batch: StoredBatch): BatchMetrics {
  const completedAt = batch.completedAt ?? new Date().toISOString();
  return {
    batchId: batch.batchId,
    startedAt: batch.startedAt,
    completedAt,
    total: batch.total,
    passed: batch.passed,
    durationMs: wallClockMs(batch.startedAt, completedAt),
  };
}

/** Explicit regression batches only (runs with batchId). Ad-hoc single runs are excluded. Newest first. */
export function groupExplicitBatches(runs: StoredRun[]): BatchMetrics[] {
  const byId = new Map<string, StoredRun[]>();
  for (const run of runs) {
    if (!run.batchId || run.trial) continue;
    const list = byId.get(run.batchId) ?? [];
    list.push(run);
    byId.set(run.batchId, list);
  }
  const metrics = [...byId.entries()].map(([batchId, items]) => metricsFromRuns(batchId, items));
  return metrics.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** @deprecated legacy time-window clustering — use groupExplicitBatches for V0.4+ metrics */
export function groupRunsIntoBatches(runs: StoredRun[]): BatchMetrics[] {
  return groupExplicitBatches(runs);
}

export function estimateLastBatchDurationMs(runs: StoredRun[]): number | null {
  return groupExplicitBatches(runs)[0]?.durationMs ?? null;
}

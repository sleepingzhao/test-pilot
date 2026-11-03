import type { StoredRun } from "./store.js";

export type BatchMetrics = {
  startedAt: string;
  completedAt: string;
  total: number;
  passed: number;
  durationMs: number;
};

/** Group runs into regression batches (runs within 120s of batch anchor). Newest batch first. */
export function groupRunsIntoBatches(runs: StoredRun[]): BatchMetrics[] {
  if (runs.length === 0) return [];
  const sorted = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const batches: StoredRun[][] = [];
  let batch: StoredRun[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i]!;
    const anchor = new Date(batch[0]!.startedAt).getTime();
    const t = new Date(r.startedAt).getTime();
    if (anchor - t <= 120_000) {
      batch.push(r);
    } else {
      batches.push(batch);
      batch = [r];
      if (batches.length >= 12) break;
    }
  }
  batches.push(batch);
  return batches.map((items) => {
    const passed = items.filter((r) => r.status === "passed").length;
    const startedAt = items.reduce((a, r) => (r.startedAt < a ? r.startedAt : a), items[0]!.startedAt);
    const completedAt = items.reduce((a, r) => (r.completedAt > a ? r.completedAt : a), items[0]!.completedAt);
    return {
      startedAt,
      completedAt,
      total: items.length,
      passed,
      durationMs: items.reduce((s, r) => s + (r.metrics?.durationMs ?? 0), 0),
    };
  });
}

export function estimateLastBatchDurationMs(runs: StoredRun[]): number | null {
  return groupRunsIntoBatches(runs)[0]?.durationMs ?? null;
}

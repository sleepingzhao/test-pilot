import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { StoredBatch, StoredRun } from "./store.js";
import { isSafeRunId, isWithin } from "./security.js";

export type CleanupCandidate = { runId: string; dir: string; reason: string; bytes: number };

export type ArtifactCleanupPlan = {
  dryRun: boolean;
  keepBatches: number;
  days: number | null;
  maxTotalBytes: number | null;
  protectedRunIds: string[];
  toRemove: CleanupCandidate[];
  toKeep: Array<{ runId: string; dir: string; bytes: number }>;
  totalBytesBefore: number;
  totalBytesAfter: number;
};

export function parseCleanupDays(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error("--days must be a positive number");
  return n;
}

export function parseKeepBatches(raw: unknown): number {
  const n = raw === undefined ? 10 : Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error("--keep-batches must be a positive integer");
  return n;
}

export async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) total += await dirSizeBytes(p);
    else if (ent.isFile()) {
      const s = await stat(p);
      total += s.size;
    }
  }
  return total;
}

async function loadBatches(dataRoot: string): Promise<StoredBatch[]> {
  const dir = join(dataRoot, "batches");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: StoredBatch[] = [];
  for (const f of files) {
    try {
      const raw = await readFile(join(dir, f), "utf8");
      out.push(JSON.parse(raw) as StoredBatch);
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

async function loadRun(dataRoot: string, runId: string): Promise<StoredRun | undefined> {
  if (!isSafeRunId(runId)) return undefined;
  try {
    const raw = await readFile(join(dataRoot, "runs", `${runId}.json`), "utf8");
    return JSON.parse(raw) as StoredRun;
  } catch {
    return undefined;
  }
}

async function loadRecentRunIds(dataRoot: string, limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  let files: string[];
  try {
    files = (await readdir(join(dataRoot, "runs"))).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const rows: Array<{ runId: string; startedAt: string }> = [];
  for (const file of files) {
    const runId = file.replace(/\.json$/, "");
    if (!isSafeRunId(runId)) continue;
    const run = await loadRun(dataRoot, runId);
    if (run) rows.push({ runId, startedAt: run.startedAt ?? "" });
  }
  return rows
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit)
    .map((r) => r.runId);
}

export function keepBatchesFromEnv(): number {
  const n = Number(process.env.TESTPILOT_ARTIFACT_KEEP_BATCHES ?? 10);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 100) : 10;
}

export function keepStandaloneRunsFromEnv(): number {
  const n = Number(process.env.TESTPILOT_ARTIFACT_KEEP_RUNS ?? 10);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 100) : 10;
}

export async function planArtifactCleanup(opts: {
  artifactsRoot: string;
  dataRoot: string;
  keepBatches: number;
  days: number | null;
  maxTotalBytes: number | null;
  dryRun: boolean;
  /** Keep artifacts for this many most recent runs even outside kept batches (trials). */
  keepStandaloneRuns?: number;
}): Promise<ArtifactCleanupPlan> {
  const runsRoot = join(opts.artifactsRoot, "runs");
  const batches = await loadBatches(opts.dataRoot);
  const protectedRunIds = new Set<string>();
  for (const batch of batches.slice(0, opts.keepBatches)) {
    for (const id of batch.runIds) protectedRunIds.add(id);
  }
  for (const id of await loadRecentRunIds(opts.dataRoot, opts.keepStandaloneRuns ?? 0)) {
    protectedRunIds.add(id);
  }

  const cutoffMs =
    opts.days == null ? Number.NEGATIVE_INFINITY : Date.now() - opts.days * 86_400_000;
  // keepBatches alone means "retain the latest N batches, prune the rest".
  const pruneUnprotected = opts.days == null && opts.maxTotalBytes == null;

  let runDirs: string[] = [];
  try {
    runDirs = (await readdir(runsRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    runDirs = [];
  }

  const entries: Array<{ runId: string; dir: string; bytes: number; mtimeMs: number; protected: boolean }> =
    [];
  for (const runId of runDirs) {
    if (!isSafeRunId(runId)) continue;
    const dir = join(runsRoot, runId);
    const bytes = await dirSizeBytes(dir);
    const st = await stat(dir);
    entries.push({
      runId,
      dir,
      bytes,
      mtimeMs: st.mtimeMs,
      protected: protectedRunIds.has(runId),
    });
  }

  const toKeep: ArtifactCleanupPlan["toKeep"] = [];
  const toRemove: CleanupCandidate[] = [];

  for (const e of entries) {
    if (e.protected) {
      toKeep.push({ runId: e.runId, dir: e.dir, bytes: e.bytes });
      continue;
    }
    const run = await loadRun(opts.dataRoot, e.runId);
    const endedAt = run?.completedAt ? Date.parse(run.completedAt) : e.mtimeMs;
    if (pruneUnprotected) {
      toRemove.push({ runId: e.runId, dir: e.dir, reason: "outside-keep-batches", bytes: e.bytes });
      continue;
    }
    if (endedAt < cutoffMs) {
      toRemove.push({ runId: e.runId, dir: e.dir, reason: "older-than-days", bytes: e.bytes });
      continue;
    }
    toKeep.push({ runId: e.runId, dir: e.dir, bytes: e.bytes });
  }

  let totalBefore = entries.reduce((s, e) => s + e.bytes, 0);
  let kept = [...toKeep];
  let remove = [...toRemove];

  if (opts.maxTotalBytes != null && totalBefore > opts.maxTotalBytes) {
    const sortedRemovable = kept
      .filter((k) => !protectedRunIds.has(k.runId))
      .sort((a, b) => a.runId.localeCompare(b.runId));
    for (const k of sortedRemovable) {
      if (totalBefore - remove.reduce((s, r) => s + r.bytes, 0) <= opts.maxTotalBytes) break;
      remove.push({ runId: k.runId, dir: k.dir, reason: "max-total-bytes", bytes: k.bytes });
      kept = kept.filter((x) => x.runId !== k.runId);
    }
  }

  const removeIds = new Set(remove.map((r) => r.runId));
  const totalAfter = entries
    .filter((e) => !removeIds.has(e.runId))
    .reduce((s, e) => s + e.bytes, 0);

  return {
    dryRun: opts.dryRun,
    keepBatches: opts.keepBatches,
    days: opts.days,
    maxTotalBytes: opts.maxTotalBytes,
    protectedRunIds: [...protectedRunIds],
    toRemove: remove,
    toKeep: kept,
    totalBytesBefore: totalBefore,
    totalBytesAfter: totalAfter,
  };
}

export async function executeArtifactCleanup(
  plan: ArtifactCleanupPlan,
  runsRoot: string,
): Promise<number> {
  // Destructive primitive: anything other than an explicit execute stays dry.
  if (plan.dryRun !== false) return 0;
  const root = resolve(runsRoot);
  let removed = 0;
  for (const item of plan.toRemove) {
    const target = resolve(item.dir);
    if (target === root || !isWithin(root, target)) continue;
    const info = await stat(target).catch(() => null);
    if (!info?.isDirectory()) continue;
    await rm(target, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** Bounded evidence retention: keep the latest N batches plus recent standalone runs. */
export async function autoPruneArtifacts(opts: {
  artifactsRoot: string;
  dataRoot: string;
  keepBatches?: number;
  keepRuns?: number;
}): Promise<number> {
  const keepBatches = opts.keepBatches ?? keepBatchesFromEnv();
  const keepRuns = opts.keepRuns ?? keepStandaloneRunsFromEnv();
  const plan = await planArtifactCleanup({
    artifactsRoot: opts.artifactsRoot,
    dataRoot: opts.dataRoot,
    keepBatches,
    days: null,
    maxTotalBytes: null,
    dryRun: false,
    keepStandaloneRuns: keepRuns,
  });
  return executeArtifactCleanup(plan, join(opts.artifactsRoot, "runs"));
}

export async function measureBatchArtifactBytes(
  artifactsRoot: string,
  runIds: string[],
): Promise<number> {
  let total = 0;
  for (const runId of runIds) {
    if (!isSafeRunId(runId)) continue;
    total += await dirSizeBytes(join(artifactsRoot, "runs", runId));
  }
  return total;
}

/** Never touches data/tests or data/runs — artifacts/runs/* only. */
export async function runArtifactCleanupCli(opts: {
  repoRoot: string;
  keepBatches: number;
  days: number | null;
  maxTotalBytes: number | null;
  dryRun: boolean;
}): Promise<ArtifactCleanupPlan> {
  const artifactsRoot = join(opts.repoRoot, "artifacts");
  const dataRoot = join(opts.repoRoot, "data");
  await mkdir(artifactsRoot, { recursive: true });
  const plan = await planArtifactCleanup({
    artifactsRoot,
    dataRoot,
    keepBatches: opts.keepBatches,
    days: opts.days,
    maxTotalBytes: opts.maxTotalBytes,
    dryRun: opts.dryRun,
  });
  await executeArtifactCleanup(plan, join(artifactsRoot, "runs"));
  return plan;
}

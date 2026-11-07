import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { StoredBatch, StoredRun } from "./store.js";
import { isSafeRunId, isWithin } from "./security.js";
import { findRunFile, listRunFiles, listSessionBatchMetas, pruneSessions } from "./session-layout.js";

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
  const out: StoredBatch[] = [];
  for (const meta of await listSessionBatchMetas(dataRoot)) {
    const { id: _id, kind: _kind, ...batch } = meta;
    out.push(batch as StoredBatch);
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

async function loadRun(dataRoot: string, runId: string): Promise<StoredRun | undefined> {
  if (!isSafeRunId(runId)) return undefined;
  const ref = await findRunFile(dataRoot, runId);
  if (!ref) return undefined;
  try {
    return JSON.parse(await readFile(ref.path, "utf8")) as StoredRun;
  } catch {
    return undefined;
  }
}

async function loadRecentRunIds(dataRoot: string, limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const rows: Array<{ runId: string; startedAt: string }> = [];
  for (const ref of await listRunFiles(dataRoot)) {
    try {
      const run = JSON.parse(await readFile(ref.path, "utf8")) as StoredRun;
      rows.push({ runId: ref.runId, startedAt: run.startedAt ?? "" });
    } catch {
      /* skip unreadable run */
    }
  }
  return rows
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit)
    .map((r) => r.runId);
}

export function keepProbesFromEnv(): number {
  const n = Number(process.env.TESTPILOT_ARTIFACT_KEEP_PROBES ?? 20);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 200) : 20;
}

export function keepSessionsFromEnv(): number {
  const n = Number(process.env.TESTPILOT_KEEP_SESSIONS ?? 20);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 500) : 20;
}

/** Negative-probe folders are gate evidence, not business runs; keep the newest N. */
export async function pruneProbeArtifacts(artifactsRoot: string, keepProbes?: number): Promise<number> {
  const keep = keepProbes ?? keepProbesFromEnv();
  const probesRoot = join(artifactsRoot, "probes");
  let names: string[];
  try {
    names = (await readdir(probesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return 0;
  }
  if (names.length <= keep) return 0;
  const stamped = await Promise.all(
    names.map(async (name) => ({
      name,
      mtime: (await stat(join(probesRoot, name))).mtimeMs,
    })),
  );
  stamped.sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const item of stamped.slice(keep)) {
    await rm(join(probesRoot, item.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

async function scanArtifactRunDirs(
  artifactsRoot: string,
): Promise<Array<{ runId: string; dir: string }>> {
  const out: Array<{ runId: string; dir: string }> = [];
  const sessionsDir = join(artifactsRoot, "sessions");
  let sessionIds: string[] = [];
  try {
    sessionIds = (await readdir(sessionsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    sessionIds = [];
  }
  for (const sessionId of sessionIds) {
    const runsDir = join(sessionsDir, sessionId, "runs");
    try {
      for (const entry of await readdir(runsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && isSafeRunId(entry.name)) {
          out.push({ runId: entry.name, dir: join(runsDir, entry.name) });
        }
      }
    } catch {
      /* session without run folders */
    }
  }
  // Legacy layout stays visible to cleanup until migration has moved everything.
  const legacyRuns = join(artifactsRoot, "runs");
  try {
    for (const entry of await readdir(legacyRuns, { withFileTypes: true })) {
      if (entry.isDirectory() && isSafeRunId(entry.name)) {
        out.push({ runId: entry.name, dir: join(legacyRuns, entry.name) });
      }
    }
  } catch {
    /* no legacy runs */
  }
  return out;
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

  const runDirs = await scanArtifactRunDirs(opts.artifactsRoot);

  const entries: Array<{ runId: string; dir: string; bytes: number; mtimeMs: number; protected: boolean }> =
    [];
  for (const { runId, dir } of runDirs) {
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

/**
 * Session retention: keep the newest N sessions (batch or standalone run) and
 * delete the rest from both data and artifacts, then trim probe folders.
 */
export async function autoPruneArtifacts(opts: {
  artifactsRoot: string;
  dataRoot: string;
  keepSessions?: number;
  keepProbes?: number;
}): Promise<number> {
  const kept = await pruneSessions({
    dataRoot: opts.dataRoot,
    artifactsRoot: opts.artifactsRoot,
    keepSessions: opts.keepSessions ?? keepSessionsFromEnv(),
  });
  const removedProbes = await pruneProbeArtifacts(opts.artifactsRoot, opts.keepProbes);
  return kept.removed + removedProbes;
}

export async function measureBatchArtifactBytes(
  artifactsRoot: string,
  runIds: string[],
): Promise<number> {
  const byRun = new Map((await scanArtifactRunDirs(artifactsRoot)).map((item) => [item.runId, item.dir]));
  let total = 0;
  for (const runId of runIds) {
    if (!isSafeRunId(runId)) continue;
    const dir = byRun.get(runId);
    if (dir) total += await dirSizeBytes(dir);
  }
  return total;
}

/** Never touches data/tests or data/sessions — artifact run folders only. */
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
  await executeArtifactCleanup(plan, artifactsRoot);
  return plan;
}

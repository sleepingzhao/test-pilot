import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isSafeRunId } from "./security.js";

/**
 * Every batch and every standalone trial is wrapped in one session folder:
 *   data/sessions/<sessionId>/session.json
 *   data/sessions/<sessionId>/runs/<runId>.json
 *   artifacts/sessions/<sessionId>/runs/<runId>/
 * A session id is always `session_` + the batch/run id, so the folder kind is
 * explicit and batch/run folders can never collide.
 */
export type SessionKind = "batch" | "trial" | "detect";

export type SessionMeta = {
  id: string;
  kind: SessionKind;
  startedAt: string;
  completedAt?: string;
  status: string;
  runIds: string[];
  batchId?: string;
  total?: number;
  passed?: number;
  mode?: string;
  repeatCount?: number;
  artifactBytesTotal?: number;
  error?: string;
  /** Detection sessions only. */
  target?: string;
  url?: string;
};

export function sessionIdForBatch(batchId: string): string {
  return `session_${batchId}`;
}

export function sessionIdForRun(runId: string): string {
  return `session_${runId}`;
}

export function sessionIdForDetect(detectionId: string): string {
  return `session_${detectionId}`;
}

export function sessionsRoot(dataRoot: string): string {
  return join(dataRoot, "sessions");
}

export function sessionDir(root: string, sessionId: string): string {
  return join(sessionsRoot(root), sessionId);
}

export function sessionMetaPath(root: string, sessionId: string): string {
  return join(sessionDir(root, sessionId), "session.json");
}

export function sessionRunsDir(root: string, sessionId: string): string {
  return join(sessionDir(root, sessionId), "runs");
}

export function sessionRunFilePath(root: string, sessionId: string, runId: string): string {
  return join(sessionRunsDir(root, sessionId), `${runId}.json`);
}

export function sessionProfilePath(root: string, sessionId: string): string {
  return join(sessionDir(root, sessionId), "profile.json");
}

export function sessionArtifactsDir(artifactsRoot: string, sessionId: string): string {
  return join(artifactsRoot, "sessions", sessionId);
}

export function sessionArtifactsRunsDir(artifactsRoot: string, sessionId: string): string {
  return join(sessionArtifactsDir(artifactsRoot, sessionId), "runs");
}

async function dirNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function fileNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function isFile(path: string): Promise<boolean> {
  return Boolean((await stat(path).catch(() => null))?.isFile());
}

export async function readSessionMeta(root: string, sessionId: string): Promise<SessionMeta | undefined> {
  try {
    return JSON.parse(await readFile(sessionMetaPath(root, sessionId), "utf8")) as SessionMeta;
  } catch {
    const runsDir = sessionRunsDir(root, sessionId);
    const runs = (await fileNames(runsDir)).filter((name) => name.endsWith(".json"));
    if (!runs.length) return undefined;
    return {
      id: sessionId,
      kind: sessionKindFromId(sessionId),
      startedAt: "",
      status: "unknown",
      runIds: runs.map((name) => name.slice(0, -5)),
    };
  }
}

export async function listSessionMetas(root: string): Promise<SessionMeta[]> {
  const out: SessionMeta[] = [];
  for (const sessionId of await dirNames(sessionsRoot(root))) {
    if (!sessionId.startsWith("session_")) continue;
    const meta = await readSessionMeta(root, sessionId);
    if (meta) out.push(meta);
  }
  return out;
}

export type RunFileRef = {
  runId: string;
  sessionId: string;
  path: string;
  kind: SessionKind;
};

/** New layout first, legacy `data/runs/*.json` only while migration is pending. */
export async function listRunFiles(dataRoot: string): Promise<RunFileRef[]> {
  const refs: RunFileRef[] = [];
  for (const sessionId of await dirNames(sessionsRoot(dataRoot))) {
    if (!sessionId.startsWith("session_")) continue;
    const kind: SessionKind = sessionKindFromId(sessionId);
    const runsDir = sessionRunsDir(dataRoot, sessionId);
    for (const file of await fileNames(runsDir)) {
      if (!file.endsWith(".json")) continue;
      const runId = file.slice(0, -5);
      if (!isSafeRunId(runId)) continue;
      refs.push({ runId, sessionId, path: join(runsDir, file), kind });
    }
  }
  for (const file of await fileNames(join(dataRoot, "runs"))) {
    if (!file.endsWith(".json")) continue;
    const runId = file.slice(0, -5);
    if (!isSafeRunId(runId)) continue;
    refs.push({
      runId,
      sessionId: sessionIdForRun(runId),
      path: join(dataRoot, "runs", file),
      kind: "trial",
    });
  }
  return refs;
}

export async function listSessionBatchMetas(dataRoot: string): Promise<SessionMeta[]> {
  return (await listSessionMetas(dataRoot)).filter((meta) => meta.kind === "batch");
}

export async function findRunFile(dataRoot: string, runId: string): Promise<RunFileRef | undefined> {
  if (!isSafeRunId(runId)) return undefined;
  for (const sessionId of await dirNames(sessionsRoot(dataRoot))) {
    if (!sessionId.startsWith("session_")) continue;
    const path = sessionRunFilePath(dataRoot, sessionId, runId);
    if (await isFile(path)) {
      return {
        runId,
        sessionId,
        path,
        kind: sessionKindFromId(sessionId),
      };
    }
  }
  const legacy = join(dataRoot, "runs", `${runId}.json`);
  if (await isFile(legacy)) {
    return { runId, sessionId: sessionIdForRun(runId), path: legacy, kind: "trial" };
  }
  return undefined;
}

async function removeIfEmpty(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => null);
  if (entries && entries.length === 0) await rm(dir, { recursive: true, force: true });
}

async function normalizeSessionFolder(
  dataRoot: string,
  sessionId: string,
): Promise<void> {
  const dir = sessionDir(dataRoot, sessionId);
  const batchFile = join(dir, "batch.json");
  const runFile = join(dir, "run.json");
  if (await isFile(batchFile)) {
    try {
      const batch = JSON.parse(await readFile(batchFile, "utf8")) as Omit<SessionMeta, "id" | "kind"> & {
        batchId: string;
      };
      const meta: SessionMeta = {
        ...batch,
        id: sessionId,
        kind: "batch",
        batchId: batch.batchId ?? sessionId.replace(/^session_/, ""),
      };
      await writeFile(sessionMetaPath(dataRoot, sessionId), JSON.stringify(meta, null, 2));
      await unlink(batchFile).catch(() => undefined);
    } catch {
      /* leave malformed batch for inspection */
    }
  }
  if (await isFile(runFile)) {
    try {
      const run = JSON.parse(await readFile(runFile, "utf8")) as { runId: string; startedAt?: string; completedAt?: string; status?: string };
      const runsDir = sessionRunsDir(dataRoot, sessionId);
      await mkdir(runsDir, { recursive: true });
      const target = join(runsDir, `${run.runId}.json`);
      if (!(await isFile(target))) await rename(runFile, target);
      else await unlink(runFile).catch(() => undefined);
      await writeFile(
        sessionMetaPath(dataRoot, sessionId),
        JSON.stringify(
          {
            id: sessionId,
            kind: "trial",
            startedAt: run.startedAt ?? "",
            completedAt: run.completedAt,
            status: run.status ?? "unknown",
            runIds: [run.runId],
          } satisfies SessionMeta,
          null,
          2,
        ),
      );
    } catch {
      /* leave malformed run for inspection */
    }
  }
  // Sessions that already have runs/ but no meta get a lightweight one.
  if (!(await isFile(sessionMetaPath(dataRoot, sessionId)))) {
    const runs = (await fileNames(sessionRunsDir(dataRoot, sessionId))).filter((n) => n.endsWith(".json"));
    if (runs.length) {
      const kind: SessionKind = sessionKindFromId(sessionId);
      await writeFile(
        sessionMetaPath(dataRoot, sessionId),
        JSON.stringify(
          {
            id: sessionId,
            kind,
            startedAt: "",
            status: "unknown",
            runIds: runs.map((n) => n.slice(0, -5)),
            ...(kind === "batch" ? { batchId: sessionId.replace(/^session_/, "") } : {}),
          } satisfies SessionMeta,
          null,
          2,
        ),
      );
    }
  }
}

/** Rename legacy `batch_*` / `run_*` folders to `session_*` and normalize contents. */
export async function migrateLegacyDataLayout(
  dataRoot: string,
): Promise<{ sessions: number; runs: number }> {
  let sessions = 0;
  let runs = 0;
  const root = sessionsRoot(dataRoot);
  await mkdir(root, { recursive: true });
  for (const name of await dirNames(root)) {
    if (name.startsWith("session_")) {
      await normalizeSessionFolder(dataRoot, name);
      continue;
    }
    const targetId = `session_${name}`;
    const target = sessionDir(dataRoot, targetId);
    if (!(await stat(target).catch(() => null))) {
      await rename(join(root, name), target);
    }
    await normalizeSessionFolder(dataRoot, targetId);
    sessions += 1;
  }

  // One-time legacy batch/run roots.
  const legacyBatches = join(dataRoot, "batches");
  for (const file of await fileNames(legacyBatches)) {
    if (!file.endsWith(".json")) continue;
    const batchId = file.slice(0, -5);
    if (!isSafeRunId(batchId)) continue;
    const sessionId = sessionIdForBatch(batchId);
    const dir = sessionDir(dataRoot, sessionId);
    await mkdir(dir, { recursive: true });
    const target = join(dir, "batch.json");
    if (!(await isFile(target))) await rename(join(legacyBatches, file), target);
    else await unlink(join(legacyBatches, file)).catch(() => undefined);
    await normalizeSessionFolder(dataRoot, sessionId);
  }
  await removeIfEmpty(legacyBatches);

  const legacyRuns = join(dataRoot, "runs");
  for (const file of await fileNames(legacyRuns)) {
    if (!file.endsWith(".json")) continue;
    const runId = file.slice(0, -5);
    if (!isSafeRunId(runId)) continue;
    let batchId: string | undefined;
    try {
      const parsed = JSON.parse(await readFile(join(legacyRuns, file), "utf8")) as { batchId?: string };
      batchId = parsed.batchId;
    } catch {
      /* keep unreadable run under its own session */
    }
    const sessionId = batchId ? sessionIdForBatch(batchId) : sessionIdForRun(runId);
    const runsDir = sessionRunsDir(dataRoot, sessionId);
    await mkdir(runsDir, { recursive: true });
    const target = join(runsDir, file);
    if (!(await isFile(target))) await rename(join(legacyRuns, file), target);
    else await unlink(join(legacyRuns, file)).catch(() => undefined);
    await normalizeSessionFolder(dataRoot, sessionId);
    runs += 1;
  }
  await removeIfEmpty(legacyRuns);

  return { sessions, runs };
}

function legacySessionId(name: string): string {
  return name.startsWith("session_") ? name : `session_${name}`;
}

function sessionKindFromId(sessionId: string): SessionKind {
  if (sessionId.startsWith("session_batch_")) return "batch";
  if (sessionId.startsWith("session_detect_")) return "detect";
  return "trial";
}

/**
 * Move artifacts into `artifacts/sessions/<sessionId>/runs/<runId>` and rewrite
 * the run's stored evidence paths so the detail page keeps working.
 */
export async function migrateArtifactLayout(
  artifactsRoot: string,
  dataRoot: string,
): Promise<number> {
  let moved = 0;
  const sessionsDir = join(artifactsRoot, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  // Rename pre-session folder names.
  for (const name of await dirNames(sessionsDir)) {
    if (name.startsWith("session_")) continue;
    const targetId = legacySessionId(name);
    const target = join(sessionsDir, targetId);
    if (!(await stat(target).catch(() => null))) await rename(join(sessionsDir, name), target);
    moved += 1;
  }

  const candidates: Array<{ runId: string; source: string }> = [];
  for (const sessionId of await dirNames(sessionsDir)) {
    if (!sessionId.startsWith("session_")) continue;
    for (const runId of await dirNames(join(sessionsDir, sessionId, "runs"))) {
      if (isSafeRunId(runId)) candidates.push({ runId, source: join(sessionsDir, sessionId, "runs", runId) });
    }
  }
  for (const runId of await dirNames(join(artifactsRoot, "runs"))) {
    if (isSafeRunId(runId)) candidates.push({ runId, source: join(artifactsRoot, "runs", runId) });
  }
  for (const name of await dirNames(artifactsRoot)) {
    if (name.startsWith("run_")) candidates.push({ runId: name, source: join(artifactsRoot, name) });
  }

  for (const { runId, source } of candidates) {
    const ref = await findRunFile(dataRoot, runId);
    let sessionId = sessionIdForRun(runId);
    if (ref) {
      try {
        const run = JSON.parse(await readFile(ref.path, "utf8")) as { batchId?: string };
        sessionId = run.batchId ? sessionIdForBatch(run.batchId) : sessionIdForRun(runId);
      } catch {
        /* group orphan under its run id */
      }
    }
    const target = join(sessionArtifactsRunsDir(artifactsRoot, sessionId), runId);
    await mkdir(dirname(target), { recursive: true });
    if (!(await stat(target).catch(() => null))) await rename(source, target).catch(() => undefined);
    if (ref) {
      try {
        const run = JSON.parse(await readFile(ref.path, "utf8")) as {
          artifacts?: { dir?: string; artifacts?: Array<{ path?: string }> };
        };
        if (run.artifacts) {
          run.artifacts.dir = target;
          for (const entry of run.artifacts.artifacts ?? []) {
            if (typeof entry.path === "string" && entry.path.startsWith(source)) {
              entry.path = target + entry.path.slice(source.length);
            }
          }
          await writeFile(ref.path, JSON.stringify(run, null, 2));
        }
      } catch {
        /* evidence paths stay as-is when the run record is unreadable */
      }
    }
    moved += 1;
  }
  await removeIfEmpty(join(artifactsRoot, "runs"));
  return moved;
}

/** Keep the newest N sessions and delete the rest from both data and artifacts. */
export async function pruneSessions(opts: {
  dataRoot: string;
  artifactsRoot: string;
  keepSessions: number;
}): Promise<{ removed: number; sessions: string[] }> {
  const metas = (await listSessionMetas(opts.dataRoot)).map((meta) => ({
    meta,
    startedAt: meta.startedAt || "",
  }));
  // Include artifact-only sessions so orphans do not survive retention.
  const known = new Set(metas.map((item) => item.meta.id));
  for (const name of await dirNames(join(opts.artifactsRoot, "sessions"))) {
    if (name.startsWith("session_") && !known.has(name)) {
      metas.push({
        meta: { id: name, kind: sessionKindFromId(name), startedAt: "", status: "unknown", runIds: [] },
        startedAt: "",
      });
    }
  }
  metas.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const keep = new Set(metas.slice(0, opts.keepSessions).map((item) => item.meta.id));
  let removed = 0;
  for (const { meta } of metas) {
    if (keep.has(meta.id)) continue;
    await rm(sessionDir(opts.dataRoot, meta.id), { recursive: true, force: true });
    await rm(sessionArtifactsDir(opts.artifactsRoot, meta.id), { recursive: true, force: true });
    removed += 1;
  }
  return { removed, sessions: metas.filter((item) => keep.has(item.meta.id)).map((item) => item.meta.id) };
}

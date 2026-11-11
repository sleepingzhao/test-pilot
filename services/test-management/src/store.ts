import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TestIR } from "@testpilot/test-ir";
import type { RunResult } from "@testpilot/runner-web";
import { isSafeRunId, isSafeTestId } from "./security.js";
import {
  findRunFile,
  listRunFiles,
  listSessionMetas,
  migrateLegacyDataLayout,
  readSessionMeta,
  sessionIdForBatch,
  sessionIdForRun,
  sessionMetaPath,
  sessionRunFilePath,
  sessionsRoot,
  type SessionMeta,
} from "./session-layout.js";

export type Project = {
  id: string;
  name: string;
  defaultBaseUrl: string;
};

export type StoredTest = {
  id: string;
  projectId: string;
  title: string;
  ir: TestIR;
  approvalStatus: "draft" | "approved";
  irHash?: string;
  irHashVersion?: number;
  approvedAt?: string;
  approvedBy?: string;
  /** IR snapshot at approval; lets a hash-algorithm rebuild keep the approval. */
  approvedIr?: TestIR;
  /** Hash of docs assertion-db/agent config at approval time. */
  assertionConfigHash?: string;
  intentSummary?: string;
  sourceChannel?: "intent" | "prd" | "record" | "api" | "mechanism";
  /** Planner uncertainties shown in review (not used at runtime). */
  plannerNotes?: string[];
  updatedAt: string;
};

export type StoredRun = RunResult & {
  projectId: string;
  testTitle: string;
  /** Draft trial runs are evidence, not regression runs; excluded from metrics. */
  trial?: boolean;
  batchId?: string;
  batchStartedAt?: string;
};

export type StoredBatch = {
  batchId: string;
  startedAt: string;
  completedAt?: string;
  total: number;
  passed: number;
  status: "running" | "completed" | "failed";
  runIds: string[];
  error?: string;
  /** full = approved-only whole suite; selected = explicit testId; include-draft = mixed. */
  mode?: "full" | "selected" | "include-draft";
  repeatCount?: number;
  /** Sum of artifact bytes for runs in this batch (best-effort at completion). */
  artifactBytesTotal?: number;
};

export type RecordJob = {
  id: string;
  status: "running" | "completed" | "failed";
  testId?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
};

export class FileStore {
  constructor(private root: string) {}

  async init() {
    await mkdir(join(this.root, "tests"), { recursive: true });
    await mkdir(sessionsRoot(this.root), { recursive: true });
    await migrateLegacyDataLayout(this.root);
  }

  project(): Project {
    return {
      id: "default",
      name: "Demo Workspace",
      defaultBaseUrl: "http://127.0.0.1:4173",
    };
  }

  async listTests(): Promise<StoredTest[]> {
    const dir = join(this.root, "tests");
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const tests: StoredTest[] = [];
    for (const f of files) {
      const raw = await readFile(join(dir, f), "utf8");
      const parsed = JSON.parse(raw) as StoredTest;
      tests.push({
        ...parsed,
        approvalStatus: parsed.approvalStatus ?? "approved",
      });
    }
    return tests.sort((a, b) => a.title.localeCompare(b.title));
  }

  async getTest(id: string): Promise<StoredTest | undefined> {
    if (!isSafeTestId(id)) return undefined;
    try {
      const raw = await readFile(join(this.root, "tests", `${id}.json`), "utf8");
      const parsed = JSON.parse(raw) as StoredTest;
      return { ...parsed, approvalStatus: parsed.approvalStatus ?? "approved" };
    } catch {
      return undefined;
    }
  }

  async saveTest(test: StoredTest): Promise<void> {
    if (!isSafeTestId(test.id)) throw new Error(`invalid test id: ${test.id}`);
    await writeFile(join(this.root, "tests", `${test.id}.json`), JSON.stringify(test, null, 2));
  }

  async deleteTest(id: string): Promise<void> {
    if (!isSafeTestId(id)) return;
    const { unlink } = await import("node:fs/promises");
    await unlink(join(this.root, "tests", `${id}.json`)).catch(() => {});
  }

  async saveRun(run: StoredRun): Promise<void> {
    if (!isSafeRunId(run.runId)) throw new Error(`invalid run id: ${run.runId}`);
    const sessionId = run.batchId ? sessionIdForBatch(run.batchId) : sessionIdForRun(run.runId);
    const path = sessionRunFilePath(this.root, sessionId, run.runId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(run, null, 2));
    if (!run.batchId) {
      // Standalone trials own their session; keep its summary in sync.
      const existing = await readSessionMeta(this.root, sessionId);
      const runIds = [...new Set([...(existing?.runIds ?? []), run.runId])];
      const meta: SessionMeta = {
        id: sessionId,
        kind: "trial",
        startedAt: existing?.startedAt || run.startedAt,
        completedAt: run.completedAt,
        status: run.status,
        runIds,
      };
      await writeFile(sessionMetaPath(this.root, sessionId), JSON.stringify(meta, null, 2));
    }
  }

  async getRun(runId: string): Promise<StoredRun | undefined> {
    if (!isSafeRunId(runId)) return undefined;
    const ref = await findRunFile(this.root, runId);
    if (!ref) return undefined;
    try {
      return JSON.parse(await readFile(ref.path, "utf8")) as StoredRun;
    } catch {
      return undefined;
    }
  }

  async listRuns(limit = 30): Promise<StoredRun[]> {
    const runs: StoredRun[] = [];
    for (const ref of await listRunFiles(this.root)) {
      try {
        runs.push(JSON.parse(await readFile(ref.path, "utf8")) as StoredRun);
      } catch {
        /* skip corrupt / vanished run */
      }
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  async saveBatch(batch: StoredBatch): Promise<void> {
    if (!isSafeRunId(batch.batchId)) throw new Error(`invalid batch id: ${batch.batchId}`);
    const sessionId = sessionIdForBatch(batch.batchId);
    const meta: SessionMeta = { ...batch, id: sessionId, kind: "batch", batchId: batch.batchId };
    const path = sessionMetaPath(this.root, sessionId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(meta, null, 2));
  }

  async getBatch(batchId: string): Promise<StoredBatch | undefined> {
    if (!isSafeRunId(batchId)) return undefined;
    const meta = await readSessionMeta(this.root, sessionIdForBatch(batchId));
    if (!meta || meta.kind !== "batch") return undefined;
    const { id: _id, kind: _kind, ...batch } = meta;
    return batch as StoredBatch;
  }

  async listBatches(limit = 20): Promise<StoredBatch[]> {
    const batches: StoredBatch[] = [];
    for (const meta of await listSessionMetas(this.root)) {
      if (meta.kind !== "batch") continue;
      const { id: _id, kind: _kind, ...batch } = meta;
      batches.push(batch as StoredBatch);
    }
    return batches.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  /**
   * A process restart leaves in-memory batch jobs behind. Reconcile persisted
   * running batches from the runs that were actually written.
   */
  async recoverInterruptedBatches(): Promise<number> {
    const batches = await this.listBatches(1000);
    const running = batches.filter((b) => b.status === "running");
    if (running.length === 0) return 0;
    const runs = await this.listRuns(10_000);
    for (const batch of running) {
      const batchRuns = runs.filter((r) => r.batchId === batch.batchId);
      const complete = batchRuns.length >= batch.total;
      await this.saveBatch({
        ...batch,
        completedAt: new Date().toISOString(),
        status: complete ? "completed" : "failed",
        passed: batchRuns.filter((r) => r.status === "passed").length,
        runIds: batchRuns.map((r) => r.runId),
        error: complete ? undefined : "interrupted by process restart",
      });
    }
    return running.length;
  }
}

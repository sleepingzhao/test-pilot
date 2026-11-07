import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  autoPruneArtifacts,
  executeArtifactCleanup,
  planArtifactCleanup,
  pruneProbeArtifacts,
} from "./artifact-cleanup.js";
import type { StoredBatch } from "./store.js";
import type { ArtifactCleanupPlan } from "./artifact-cleanup.js";

async function fixtureTree(): Promise<{ root: string; artifacts: string; data: string; runsRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "tp-artifacts-"));
  const artifacts = join(root, "artifacts");
  const data = join(root, "data");
  const runsRoot = join(artifacts, "runs");
  await mkdir(join(runsRoot, "run_old"), { recursive: true });
  await mkdir(join(runsRoot, "run_keep"), { recursive: true });
  await writeFile(join(runsRoot, "run_old", "trace.zip"), "old");
  await writeFile(join(runsRoot, "run_keep", "trace.zip"), "keep");
  await writeFile(join(artifacts, "negative-probes-last.json"), "{}");
  await mkdir(join(data, "sessions", "session_batch_1"), { recursive: true });
  await mkdir(join(data, "runs"), { recursive: true });
  await mkdir(join(data, "tests"), { recursive: true });
  await writeFile(join(data, "tests", "t1.json"), "{}");
  const batch: StoredBatch = {
    batchId: "batch_1",
    startedAt: new Date().toISOString(),
    total: 1,
    passed: 1,
    status: "completed",
    runIds: ["run_keep"],
  };
  await writeFile(
    join(data, "sessions", "session_batch_1", "session.json"),
    JSON.stringify({ ...batch, id: "session_batch_1", kind: "batch" }),
  );
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  await writeFile(
    join(data, "runs", "run_old.json"),
    JSON.stringify({ runId: "run_old", completedAt: old, testId: "t", status: "failed" }),
  );
  return { root, artifacts, data, runsRoot };
}

test("dry-run does not delete artifact dirs and undefined dryRun stays safe (negative)", async () => {
  const { root, artifacts, data, runsRoot } = await fixtureTree();
  try {
    const plan = await planArtifactCleanup({
      artifactsRoot: artifacts,
      dataRoot: data,
      keepBatches: 2,
      days: 7,
      maxTotalBytes: null,
      dryRun: true,
    });
    assert.ok(plan.toRemove.some((r) => r.runId === "run_old"));
    assert.ok(!plan.toRemove.some((r) => r.runId === "run_keep"));
    assert.equal(await executeArtifactCleanup(plan, runsRoot), 0);
    await stat(join(runsRoot, "run_old"));

    const unsafe = { ...plan, dryRun: undefined } as unknown as ArtifactCleanupPlan;
    assert.equal(await executeArtifactCleanup(unsafe, runsRoot), 0);
    await stat(join(runsRoot, "run_old"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("execute removes only unprotected stale runs and leaves data untouched (positive)", async () => {
  const { root, artifacts, data, runsRoot } = await fixtureTree();
  try {
    const plan = await planArtifactCleanup({
      artifactsRoot: artifacts,
      dataRoot: data,
      keepBatches: 2,
      days: 7,
      maxTotalBytes: null,
      dryRun: false,
    });
    assert.equal(plan.toRemove.length, 1);
    assert.equal(await executeArtifactCleanup(plan, runsRoot), 1);

    await assert.rejects(stat(join(runsRoot, "run_old")));
    await stat(join(runsRoot, "run_keep", "trace.zip"));
    assert.equal(await readFile(join(data, "tests", "t1.json"), "utf8"), "{}");
    await stat(join(data, "sessions", "session_batch_1", "session.json"));
    await stat(join(artifacts, "negative-probes-last.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("executor refuses a path outside artifacts/runs", async () => {
  const { root, runsRoot } = await fixtureTree();
  const outside = join(root, "keep-me");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "precious.txt"), "keep");
  try {
    const plan = {
      dryRun: false,
      keepBatches: 1,
      days: null,
      maxTotalBytes: null,
      protectedRunIds: [],
      toRemove: [{ runId: "outside", dir: outside, reason: "forged", bytes: 1 }],
      toKeep: [],
      totalBytesBefore: 1,
      totalBytesAfter: 0,
    } satisfies ArtifactCleanupPlan;

    assert.equal(await executeArtifactCleanup(plan, runsRoot), 0);
    await stat(join(outside, "precious.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keepBatches alone prunes runs outside the kept batches", async () => {
  const { root, artifacts, data, runsRoot } = await fixtureTree();
  try {
    const plan = await planArtifactCleanup({
      artifactsRoot: artifacts,
      dataRoot: data,
      keepBatches: 1,
      days: null,
      maxTotalBytes: null,
      dryRun: false,
    });
    assert.deepEqual(plan.toRemove.map((r) => r.runId), ["run_old"]);
    assert.equal(await executeArtifactCleanup(plan, runsRoot), 1);
    await assert.rejects(stat(join(runsRoot, "run_old")));
    await stat(join(runsRoot, "run_keep", "trace.zip"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic pruning keeps only the newest sessions in data and artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "tp-sessions-retention-"));
  const data = join(root, "data");
  const artifacts = join(root, "artifacts");
  const now = Date.now();
  const sessions = [
    ["session_batch_old", new Date(now - 3 * 60_000).toISOString()],
    ["session_run_mid", new Date(now - 2 * 60_000).toISOString()],
    ["session_run_new", new Date(now - 60_000).toISOString()],
  ] as const;
  try {
    for (const [id, startedAt] of sessions) {
      await mkdir(join(data, "sessions", id, "runs"), { recursive: true });
      await writeFile(
        join(data, "sessions", id, "session.json"),
        JSON.stringify({ id, kind: id.includes("_batch_") ? "batch" : "trial", startedAt, status: "completed", runIds: [] }),
      );
      await mkdir(join(artifacts, "sessions", id, "runs", `run_${id}`), { recursive: true });
      await writeFile(join(artifacts, "sessions", id, "runs", `run_${id}`, "trace.zip"), "trace");
    }
    const removed = await autoPruneArtifacts({
      artifactsRoot: artifacts,
      dataRoot: data,
      keepSessions: 2,
      keepProbes: 20,
    });
    assert.equal(removed, 1);
    await assert.rejects(stat(join(data, "sessions", "session_batch_old")));
    await assert.rejects(stat(join(artifacts, "sessions", "session_batch_old")));
    await stat(join(data, "sessions", "session_run_mid", "session.json"));
    await stat(join(data, "sessions", "session_run_new", "session.json"));
    await stat(join(artifacts, "sessions", "session_run_new", "runs", "run_session_run_new", "trace.zip"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps only the newest negative-probe folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "tp-probes-"));
  const probes = join(root, "probes");
  const now = Date.now();
  const names = ["probe_old", "probe_mid", "probe_new"];
  try {
    for (const [i, name] of names.entries()) {
      await mkdir(join(probes, name), { recursive: true });
      await writeFile(join(probes, name, "manifest.json"), "{}");
      const when = new Date(now - (names.length - i) * 60_000);
      await utimes(join(probes, name), when, when);
    }
    const removed = await pruneProbeArtifacts(root, 2);
    assert.equal(removed, 1);
    await assert.rejects(stat(join(probes, "probe_old")));
    await stat(join(probes, "probe_mid"));
    await stat(join(probes, "probe_new"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

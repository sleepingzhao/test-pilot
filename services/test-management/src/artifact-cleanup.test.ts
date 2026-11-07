import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeArtifactCleanup, planArtifactCleanup } from "./artifact-cleanup.js";
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
  await mkdir(join(data, "batches"), { recursive: true });
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
  await writeFile(join(data, "batches", "batch_1.json"), JSON.stringify(batch));
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
    await stat(join(data, "batches", "batch_1.json"));
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

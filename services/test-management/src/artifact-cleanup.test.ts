import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeArtifactCleanup, planArtifactCleanup } from "./artifact-cleanup.js";
import type { StoredBatch } from "./store.js";

async function fixtureTree(): Promise<{ root: string; artifacts: string; data: string }> {
  const root = await mkdtemp(join(tmpdir(), "tp-artifacts-"));
  const artifacts = join(root, "artifacts");
  const data = join(root, "data");
  await mkdir(join(artifacts, "runs", "run_old"), { recursive: true });
  await mkdir(join(artifacts, "runs", "run_keep"), { recursive: true });
  await writeFile(join(artifacts, "runs", "run_old", "trace.zip"), "old");
  await writeFile(join(artifacts, "runs", "run_keep", "trace.zip"), "keep");
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
  return { root, artifacts, data };
}

test("dry-run does not delete artifact dirs (negative)", async () => {
  const { artifacts, data } = await fixtureTree();
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
  const removed = await executeArtifactCleanup(plan);
  assert.equal(removed, 0);
});

test("execute removes only unprotected stale runs (positive)", async () => {
  const { artifacts, data } = await fixtureTree();
  const plan = await planArtifactCleanup({
    artifactsRoot: artifacts,
    dataRoot: data,
    keepBatches: 2,
    days: 7,
    maxTotalBytes: null,
    dryRun: false,
  });
  const removed = await executeArtifactCleanup(plan);
  assert.equal(removed, 1);
  assert.equal(plan.toRemove.length, 1);
});

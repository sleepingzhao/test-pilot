import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileStore, type StoredBatch, type StoredRun } from "./store.js";
import { migrateArtifactLayout } from "./session-layout.js";

function makeRun(runId: string, batchId?: string): StoredRun {
  return {
    runId,
    testId: "t",
    testVersion: 1,
    status: "passed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    steps: [],
    assertions: [],
    artifacts: { runId, dir: "", artifacts: [] },
    projectId: "default",
    testTitle: "t",
    ...(batchId ? { batchId } : {}),
  };
}

function makeBatch(batchId: string, runIds: string[]): StoredBatch {
  return {
    batchId,
    startedAt: new Date().toISOString(),
    total: runIds.length,
    passed: runIds.length,
    status: "completed",
    runIds,
  };
}

test("batches and standalone trials both sit inside session_* folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "tp-sessions-"));
  const store = new FileStore(root);
  await store.init();
  try {
    await store.saveBatch(makeBatch("batch_1", ["run_b"]));
    await store.saveRun(makeRun("run_b", "batch_1"));
    await store.saveRun(makeRun("run_solo"));

    await stat(join(root, "sessions", "session_batch_1", "session.json"));
    await stat(join(root, "sessions", "session_batch_1", "runs", "run_b.json"));
    await stat(join(root, "sessions", "session_run_solo", "session.json"));
    await stat(join(root, "sessions", "session_run_solo", "runs", "run_solo.json"));

    assert.equal((await store.getRun("run_b"))?.batchId, "batch_1");
    assert.equal((await store.getRun("run_solo"))?.runId, "run_solo");
    assert.deepEqual((await store.listBatches()).map((b) => b.batchId), ["batch_1"]);
    assert.deepEqual(
      (await store.listRuns(10)).map((r) => r.runId).sort(),
      ["run_b", "run_solo"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy runs and batches migrate into session_* folders on init", async () => {
  const root = await mkdtemp(join(tmpdir(), "tp-legacy-"));
  await mkdir(join(root, "batches"), { recursive: true });
  await mkdir(join(root, "runs"), { recursive: true });
  await writeFile(
    join(root, "batches", "batch_old.json"),
    JSON.stringify(makeBatch("batch_old", ["run_in_batch"])),
  );
  await writeFile(
    join(root, "runs", "run_in_batch.json"),
    JSON.stringify(makeRun("run_in_batch", "batch_old")),
  );
  await writeFile(join(root, "runs", "run_trial.json"), JSON.stringify(makeRun("run_trial")));
  try {
    const store = new FileStore(root);
    await store.init();
    await stat(join(root, "sessions", "session_batch_old", "session.json"));
    await stat(join(root, "sessions", "session_batch_old", "runs", "run_in_batch.json"));
    await stat(join(root, "sessions", "session_run_trial", "session.json"));
    await stat(join(root, "sessions", "session_run_trial", "runs", "run_trial.json"));
    await assert.rejects(stat(join(root, "runs")));
    await assert.rejects(stat(join(root, "batches")));
    assert.equal((await store.getRun("run_in_batch"))?.batchId, "batch_old");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact migration moves runs into session folders and rewrites evidence paths", async () => {
  const repo = await mkdtemp(join(tmpdir(), "tp-artifact-sessions-"));
  const dataRoot = join(repo, "data");
  const artifactsRoot = join(repo, "artifacts");
  const oldDir = join(artifactsRoot, "runs", "run_b");
  const oldTrace = join(oldDir, "trace.zip");
  await mkdir(oldDir, { recursive: true });
  await writeFile(oldTrace, "trace");
  const store = new FileStore(dataRoot);
  await store.init();
  const run = makeRun("run_b", "batch_1");
  run.artifacts = {
    runId: "run_b",
    dir: oldDir,
    artifacts: [{ kind: "trace", path: oldTrace }],
  };
  await store.saveBatch(makeBatch("batch_1", ["run_b"]));
  await store.saveRun(run);
  try {
    const moved = await migrateArtifactLayout(artifactsRoot, dataRoot);
    assert.equal(moved, 1);
    const newDir = join(artifactsRoot, "sessions", "session_batch_1", "runs", "run_b");
    await stat(join(newDir, "trace.zip"));
    await assert.rejects(stat(join(artifactsRoot, "runs")));
    const stored = JSON.parse(
      await readFile(join(dataRoot, "sessions", "session_batch_1", "runs", "run_b.json"), "utf8"),
    ) as StoredRun;
    assert.equal(stored.artifacts.dir, newDir);
    assert.equal(stored.artifacts.artifacts[0]?.path, join(newDir, "trace.zip"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

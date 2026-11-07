import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileStore, type StoredRun } from "./store.js";

function run(id: string, batchId: string, status: StoredRun["status"] = "passed"): StoredRun {
  return {
    runId: id,
    testId: "t",
    testTitle: "t",
    testVersion: 1,
    projectId: "default",
    batchId,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status,
    steps: [],
    assertions: [],
    artifacts: { runId: id, dir: `artifacts/runs/${id}`, artifacts: [] },
    metrics: { durationMs: 1, llmTokensUsed: 0, attemptCount: 1 },
  };
}

test("saveBatch round-trips batch manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-batch-"));
  const store = new FileStore(root);
  await store.init();
  try {
    const batch = {
      batchId: "batch_test",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      total: 2,
      passed: 2,
      status: "completed" as const,
      runIds: ["run_a", "run_b"],
      mode: "full" as const,
      repeatCount: 1,
    };
    await store.saveBatch(batch);
    const loaded = await store.getBatch("batch_test");
    assert.deepEqual(loaded, batch);
    const list = await store.listBatches();
    assert.equal(list[0]?.batchId, "batch_test");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recoverInterruptedBatches reconstructs interrupted batches from runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-batch-recover-"));
  const store = new FileStore(root);
  await store.init();
  try {
    await store.saveBatch({
      batchId: "batch_running",
      startedAt: new Date().toISOString(),
      total: 2,
      passed: 0,
      status: "running",
      runIds: [],
      mode: "full",
      repeatCount: 1,
    });
    await store.saveRun(run("run_1", "batch_running", "passed"));
    await store.saveRun(run("run_2", "batch_running", "failed"));

    assert.equal(await store.recoverInterruptedBatches(), 1);
    const recovered = await store.getBatch("batch_running");
    assert.equal(recovered?.status, "completed");
    assert.equal(recovered?.passed, 1);
    assert.deepEqual(recovered?.runIds.sort(), ["run_1", "run_2"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listBatches skips a corrupt batch file instead of failing", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-batch-corrupt-"));
  const store = new FileStore(root);
  await store.init();
  try {
    await store.saveBatch({
      batchId: "batch_ok",
      startedAt: new Date().toISOString(),
      total: 1,
      passed: 1,
      status: "completed",
      runIds: [],
      mode: "full",
      repeatCount: 1,
    });
    await mkdir(join(root, "sessions", "session_batch_broken"), { recursive: true });
    await writeFile(join(root, "sessions", "session_batch_broken", "session.json"), "{not-json");
    const list = await store.listBatches();
    assert.deepEqual(list.map((b) => b.batchId), ["batch_ok"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

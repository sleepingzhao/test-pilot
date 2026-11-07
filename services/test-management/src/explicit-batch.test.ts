import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileStore } from "./store.js";

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

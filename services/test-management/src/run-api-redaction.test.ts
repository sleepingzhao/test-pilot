import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { registerRoutes } from "./routes.js";
import { FileStore, type StoredRun } from "./store.js";

function sensitiveRun(): StoredRun {
  return {
    runId: "run_secret",
    testId: "demo",
    testTitle: "demo",
    testVersion: 1,
    projectId: "default",
    batchId: "batch_secret",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "failed",
    steps: [
      {
        stepId: "open",
        status: "failed",
        durationMs: 1,
        message: "page.goto https://app.example/api?phone=13800138000 failed for user@example.com",
      },
    ],
    assertions: [
      {
        assertionId: "a",
        passed: false,
        message: "expected user@example.com",
        expected: { email: "user@example.com" },
        actual: { phone: "13800138000" },
      },
    ],
    artifacts: {
      runId: "run_secret",
      dir: "artifacts/runs/run_secret",
      artifacts: [{ kind: "trace", path: "artifacts/runs/run_secret/trace.zip" }],
    },
    metrics: { durationMs: 1, llmTokensUsed: 0, attemptCount: 1 },
  };
}

test("run APIs redact historical PII and report artifact presence", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-run-api-"));
  const dataRoot = join(root, "data");
  const artifactsRoot = join(root, "artifacts");
  const store = new FileStore(dataRoot);
  await store.init();
  await mkdir(join(artifactsRoot, "runs", "run_secret"), { recursive: true });
  await writeFile(join(artifactsRoot, "runs", "run_secret", "network.json"), "[]");
  const run = sensitiveRun();
  await store.saveRun({ ...run, artifacts: { ...run.artifacts, dir: join(artifactsRoot, "runs", "run_secret") } });
  await store.saveBatch({
    batchId: "batch_secret",
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    total: 1,
    passed: 0,
    status: "completed",
    runIds: ["run_secret"],
    mode: "full",
    repeatCount: 1,
  });

  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, artifactsRoot, dataRoot);
  await app.ready();
  try {
    const detail = await app.inject({ method: "GET", url: "/api/runs/run_secret" });
    assert.equal(detail.statusCode, 200);
    const detailText = detail.body;
    assert.doesNotMatch(detailText, /13800138000/);
    assert.doesNotMatch(detailText, /user@example\.com/);
    const body = detail.json() as { artifactsPresent?: Record<string, boolean> };
    assert.equal(body.artifactsPresent?.network, true);
    assert.equal(body.artifactsPresent?.trace, false);

    const list = await app.inject({ method: "GET", url: "/api/runs" });
    assert.equal(list.statusCode, 200);
    assert.doesNotMatch(list.body, /13800138000/);
    assert.doesNotMatch(list.body, /user@example\.com/);

    const batch = await app.inject({ method: "GET", url: "/api/batches/batch_secret" });
    assert.equal(batch.statusCode, 200);
    assert.doesNotMatch(batch.body, /13800138000/);
    assert.doesNotMatch(batch.body, /user@example\.com/);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

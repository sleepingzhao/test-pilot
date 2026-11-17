import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { registerRoutes } from "./routes.js";
import { FileStore, type StoredRun } from "./store.js";

function baseRun(partial: Partial<StoredRun> = {}): StoredRun {
  return {
    runId: "run_ws_ok",
    testId: "demo",
    testTitle: "demo",
    testVersion: 1,
    projectId: "default",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "passed",
    steps: [],
    assertions: [],
    artifacts: {
      runId: "run_ws_ok",
      dir: "",
      artifacts: [],
    },
    metrics: { durationMs: 1, llmTokensUsed: 0, attemptCount: 1 },
    ...partial,
  };
}

test("GET /api/runs/:runId/ws returns frames from registered ws artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-run-ws-"));
  const dataRoot = join(root, "data");
  const artifactsRoot = join(root, "artifacts");
  const runDir = join(artifactsRoot, "runs", "run_ws_ok");
  await mkdir(runDir, { recursive: true });
  const wsBody = {
    limit: 200,
    dropped: 2,
    note: "dropped 2 websocket frames beyond the limit of 200",
    frames: [
      {
        url: "ws://127.0.0.1:1/ws/chat",
        direction: "sent",
        size: 12,
        payload: '{"text":"hello"}',
        at: "2026-01-02T10:00:00.000Z",
      },
      {
        url: "ws://127.0.0.1:1/ws/chat",
        direction: "received",
        size: 14,
        payload: '{"text":"hello"}',
        at: "2026-01-02T10:00:00.100Z",
      },
    ],
  };
  await writeFile(join(runDir, "ws.json"), JSON.stringify(wsBody, null, 2));

  const store = new FileStore(dataRoot);
  await store.init();
  await store.saveRun(
    baseRun({
      artifacts: {
        runId: "run_ws_ok",
        dir: runDir,
        artifacts: [{ kind: "ws", path: join(runDir, "ws.json") }],
      },
    }),
  );

  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, artifactsRoot, dataRoot);
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/runs/run_ws_ok/ws" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      ws: { limit: number; dropped: number; note?: string; frames: unknown[] };
    };
    assert.equal(body.ws.limit, 200);
    assert.equal(body.ws.dropped, 2);
    assert.equal(body.ws.note, wsBody.note);
    assert.equal(body.ws.frames.length, 2);
    assert.equal((body.ws.frames[0] as { direction: string }).direction, "sent");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("GET /api/runs/:runId/ws returns 404 when no ws artifact (negative)", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-run-ws-missing-"));
  const dataRoot = join(root, "data");
  const artifactsRoot = join(root, "artifacts");
  const store = new FileStore(dataRoot);
  await store.init();
  await store.saveRun(
    baseRun({
      runId: "run_no_ws",
      artifacts: {
        runId: "run_no_ws",
        dir: join(artifactsRoot, "runs", "run_no_ws"),
        artifacts: [{ kind: "network", path: "network.json" }],
      },
    }),
  );

  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, artifactsRoot, dataRoot);
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/runs/run_no_ws/ws" });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("GET /api/runs/:runId/ws returns 502 for malformed ws.json (negative)", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-run-ws-bad-"));
  const dataRoot = join(root, "data");
  const artifactsRoot = join(root, "artifacts");
  const runDir = join(artifactsRoot, "runs", "run_ws_bad");
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "ws.json"), "{ not valid json");

  const store = new FileStore(dataRoot);
  await store.init();
  await store.saveRun(
    baseRun({
      runId: "run_ws_bad",
      artifacts: {
        runId: "run_ws_bad",
        dir: runDir,
        artifacts: [{ kind: "ws", path: join(runDir, "ws.json") }],
      },
    }),
  );

  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, artifactsRoot, dataRoot);
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/runs/run_ws_bad/ws" });
    assert.equal(res.statusCode, 502);
    const body = res.json() as { error: string };
    assert.equal(body.error, "ws.json 无法解析");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
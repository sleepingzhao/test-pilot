import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { registerRoutes, resetRecordStateForTest, seedRecordJobForTest } from "./routes.js";
import { FileStore } from "./store.js";

const visionEnvOff = {
  TESTPILOT_VISION_ENABLED: undefined,
  TESTPILOT_VISION_API_KEY: undefined,
  TESTPILOT_LLM_API_KEY: undefined,
};

const visionEnvOn = {
  TESTPILOT_VISION_ENABLED: "1",
  TESTPILOT_VISION_API_KEY: "sk-test-vision",
};

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const keys = new Set([...Object.keys(vars), ...Object.keys(visionEnvOff)]);
  const previous = new Map([...keys].map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function makeApp() {
  const root = await mkdtemp(join(tmpdir(), "testpilot-record-locate-"));
  const store = new FileStore(join(root, "data"));
  await store.init();
  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, join(root, "artifacts"), join(root, "data"));
  await app.ready();
  return { app, root };
}

test("POST locate returns 503 when vision disabled", async () => {
  await withEnv(visionEnvOff, async () => {
    resetRecordStateForTest();
    const { app, root } = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/record/rec_test_job/locate",
        payload: { instruction: "提交按钮" },
      });
      assert.equal(res.statusCode, 503);
      const body = res.json() as { error?: string };
      assert.match(body.error ?? "", /TESTPILOT_VISION_ENABLED/);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
      resetRecordStateForTest();
    }
  });
});

test("POST locate returns 404 for unknown job", async () => {
  await withEnv(visionEnvOn, async () => {
    resetRecordStateForTest();
    const { app, root } = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/record/rec_missing_job/locate",
        payload: { instruction: "提交按钮" },
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
      resetRecordStateForTest();
    }
  });
});

test("POST locate returns 400 for empty instruction", async () => {
  await withEnv(visionEnvOn, async () => {
    resetRecordStateForTest();
    seedRecordJobForTest({
      id: "rec_running_job",
      status: "running",
      startedAt: new Date().toISOString(),
    });
    const { app, root } = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/record/rec_running_job/locate",
        payload: { instruction: "  " },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
      resetRecordStateForTest();
    }
  });
});
test("POST record rejects invalid multi-actor configuration before launching a browser", async () => {
  resetRecordStateForTest();
  const { app, root } = await makeApp();
  try {
    const base = {
      url: "http://127.0.0.1:4173/",
      testId: "rec-multi",
      title: "multi",
    };
    const badId = await app.inject({
      method: "POST",
      url: "/api/record",
      payload: { ...base, actors: [{ id: "primary" }, { id: "Bad Id" }] },
    });
    assert.equal(badId.statusCode, 400);
    assert.match((badId.json() as { error: string }).error, /actor id/);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/record",
      payload: { ...base, actors: [{ id: "b" }, { id: "b" }] },
    });
    assert.equal(duplicate.statusCode, 400);
    assert.match((duplicate.json() as { error: string }).error, /重复/);

    const tooMany = await app.inject({
      method: "POST",
      url: "/api/record",
      payload: { ...base, actors: Array.from({ length: 9 }, (_, i) => ({ id: `a${i}` })) },
    });
    assert.equal(tooMany.statusCode, 400);
    assert.match((tooMany.json() as { error: string }).error, /最多 8 个/);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
    resetRecordStateForTest();
  }
});

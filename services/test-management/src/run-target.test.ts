import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sensible from "@fastify/sensible";
import type { TestIR } from "@testpilot/test-ir";
import Fastify from "fastify";
import { registerRoutes } from "./routes.js";
import { FileStore, type StoredTest } from "./store.js";

function makeTest(id: string, ir: TestIR): StoredTest {
  return {
    id,
    projectId: "default",
    title: id,
    ir,
    approvalStatus: "approved",
    updatedAt: new Date().toISOString(),
  };
}

test("runs reject pinned targets outside the allow-list and missing env refs", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-runs-"));
  const dataRoot = join(root, "data");
  const store = new FileStore(dataRoot);
  await store.init();

  const blocked: TestIR = {
    id: "blocked-target",
    version: 1,
    platform: "web",
    baseUrl: "http://169.254.169.254",
    steps: [{ id: "open", action: "navigate", path: "/" }],
    assertions: [{ id: "ok", type: "ui", contains: "ok", oracle: "human-approved" }],
  };
  await store.saveTest(makeTest(blocked.id, blocked));

  const missingSecret: TestIR = {
    id: "missing-secret",
    version: 1,
    platform: "web",
    baseUrl: "http://127.0.0.1:4173",
    steps: [
      { id: "open", action: "navigate", path: "/" },
      { id: "password", action: "fill", target: { label: "密码" }, valueRef: "env.adminPassword" },
    ],
    assertions: [{ id: "ok", type: "ui", contains: "ok", oracle: "human-approved" }],
  };
  await store.saveTest(makeTest(missingSecret.id, missingSecret));

  const previousPassword = process.env.TESTPILOT_ENV_ADMIN_PASSWORD;
  delete process.env.TESTPILOT_ENV_ADMIN_PASSWORD;

  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, join(root, "artifacts"), dataRoot);
  await app.ready();
  try {
    const blockedRes = await app.inject({
      method: "POST",
      url: "/api/projects/default/runs",
      payload: { testId: blocked.id },
    });
    assert.equal(blockedRes.statusCode, 400);
    assert.match(blockedRes.json().error, /不在允许列表/);

    const missingRes = await app.inject({
      method: "POST",
      url: "/api/projects/default/runs",
      payload: { testId: missingSecret.id },
    });
    assert.equal(missingRes.statusCode, 503);
    assert.match(missingRes.json().error, /TESTPILOT_ENV_ADMIN_PASSWORD/);
  } finally {
    if (previousPassword === undefined) delete process.env.TESTPILOT_ENV_ADMIN_PASSWORD;
    else process.env.TESTPILOT_ENV_ADMIN_PASSWORD = previousPassword;
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("runs reject absolute step URLs outside the allow-list", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-abs-step-"));
  const dataRoot = join(root, "data");
  const store = new FileStore(dataRoot);
  await store.init();

  const ir: TestIR = {
    id: "absolute-step",
    version: 1,
    platform: "web",
    baseUrl: "http://127.0.0.1:4173",
    steps: [
      { id: "open", action: "navigate", path: "/" },
      { id: "ssrf", action: "navigate", path: "http://169.254.169.254/latest/meta-data" },
    ],
    assertions: [{ id: "ok", type: "ui", contains: "ok", oracle: "human-approved" }],
  };
  await store.saveTest(makeTest(ir.id, ir));

  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, join(root, "artifacts"), dataRoot);
  await app.ready();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/default/runs",
      payload: { testId: ir.id },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /步骤目标地址不在允许列表/);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

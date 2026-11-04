import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sensible from "@fastify/sensible";
import { computeIRHash } from "@testpilot/test-ir";
import Fastify from "fastify";
import { registerRoutes } from "./routes.js";
import { FileStore } from "./store.js";

test("approval is pinned to the reviewed IR hash and records the actor", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-approval-"));
  const dataRoot = join(root, "data");
  const store = new FileStore(dataRoot);
  await store.init();

  const testId = "demo-approval";
  const ir = {
    id: testId,
    version: 1,
    platform: "web" as const,
    steps: [{ id: "open", action: "navigate" as const, path: "/" }],
    assertions: [
      { id: "ok", type: "ui" as const, contains: "saved", oracle: "human-approved" as const },
    ],
  };
  await store.saveTest({
    id: testId,
    projectId: "default",
    title: "approval",
    ir,
    approvalStatus: "draft",
    updatedAt: new Date().toISOString(),
  });

  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, join(root, "artifacts"), dataRoot);
  await app.ready();

  try {
    const missing = await app.inject({
      method: "POST",
      url: `/api/tests/${testId}/approve`,
      payload: {},
    });
    assert.equal(missing.statusCode, 400);

    const stale = await app.inject({
      method: "POST",
      url: `/api/tests/${testId}/approve`,
      payload: { irHash: "0000000000000000" },
    });
    assert.equal(stale.statusCode, 409);

    const hash = computeIRHash(ir);
    const approved = await app.inject({
      method: "POST",
      url: `/api/tests/${testId}/approve`,
      payload: { irHash: hash },
      headers: { "x-testpilot-actor": "qa-bot" },
    });
    assert.equal(approved.statusCode, 200);
    const body = approved.json() as {
      approvalStatus: string;
      approvedBy?: string;
      irHash?: string;
    };
    assert.equal(body.approvalStatus, "approved");
    assert.equal(body.approvedBy, "qa-bot");
    assert.equal(body.irHash, hash);

    const stored = await store.getTest(testId);
    assert.equal(stored?.approvalStatus, "approved");
    assert.equal(stored?.approvedBy, "qa-bot");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("approval rejects db assertion with unknown queryRef", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-approval-db-"));
  const dataRoot = join(root, "data");
  const store = new FileStore(dataRoot);
  await store.init();

  const testId = "bad-db-query";
  const ir = {
    id: testId,
    version: 1,
    platform: "web" as const,
    steps: [{ id: "open", action: "navigate" as const, path: "/" }],
    assertions: [
      {
        id: "db1",
        type: "db" as const,
        provider: "postgres-readonly",
        configRef: "pilot-db",
        oracle: "human-approved" as const,
        expect: { queryRef: "no-such-query", rowCount: 1 },
      },
    ],
  };
  await store.saveTest({
    id: testId,
    projectId: "default",
    title: "bad db",
    ir,
    approvalStatus: "draft",
    updatedAt: new Date().toISOString(),
  });

  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, join(root, "artifacts"), dataRoot);
  await app.ready();

  try {
    const hash = computeIRHash(ir);
    const res = await app.inject({
      method: "POST",
      url: `/api/tests/${testId}/approve`,
      payload: { irHash: hash },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { issues?: Array<{ message: string }> };
    assert.ok(body.issues?.some((i) => i.message.includes("命名查询")));
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("approval rejects agent assertion with empty expect rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-approval-agent-"));
  const dataRoot = join(root, "data");
  const store = new FileStore(dataRoot);
  await store.init();

  const testId = "bad-agent-expect";
  const ir = {
    id: testId,
    version: 1,
    platform: "web" as const,
    steps: [{ id: "open", action: "navigate" as const, path: "/" }],
    assertions: [
      {
        id: "a1",
        type: "agent" as const,
        provider: "otel-trace",
        configRef: "agent-observability",
        oracle: "human-approved" as const,
        expect: {},
      },
    ],
  };
  await store.saveTest({
    id: testId,
    projectId: "default",
    title: "bad agent",
    ir,
    approvalStatus: "draft",
    updatedAt: new Date().toISOString(),
  });

  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, join(root, "artifacts"), dataRoot);
  await app.ready();

  try {
    const hash = computeIRHash(ir);
    const res = await app.inject({
      method: "POST",
      url: `/api/tests/${testId}/approve`,
      payload: { irHash: hash },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { issues?: Array<{ message: string }> };
    assert.ok(body.issues?.some((i) => i.message.includes("forbiddenTools") || i.message.includes("toolCalls")));
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("approval rejects unknown assertion provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-approval-provider-"));
  const dataRoot = join(root, "data");
  const store = new FileStore(dataRoot);
  await store.init();

  const testId = "bad-provider";
  const ir = {
    id: testId,
    version: 1,
    platform: "web" as const,
    steps: [{ id: "open", action: "navigate" as const, path: "/" }],
    assertions: [
      {
        id: "x",
        type: "ui" as const,
        provider: "unknown-provider",
        contains: "saved ok text here",
        oracle: "human-approved" as const,
      },
    ],
  };
  await store.saveTest({
    id: testId,
    projectId: "default",
    title: "bad provider",
    ir,
    approvalStatus: "draft",
    updatedAt: new Date().toISOString(),
  });

  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, join(root, "artifacts"), dataRoot);
  await app.ready();

  try {
    const hash = computeIRHash(ir);
    const res = await app.inject({
      method: "POST",
      url: `/api/tests/${testId}/approve`,
      payload: { irHash: hash },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { issues?: Array<{ message: string }> };
    assert.ok(body.issues?.some((i) => i.message.includes("未知的断言 Provider")));
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

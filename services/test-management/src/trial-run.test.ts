import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { registerRoutes } from "./routes.js";
import { FileStore } from "./store.js";

test("trial-run rejects missing ir, id mismatch, and invalid IR", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-trial-"));
  const dataRoot = join(root, "data");
  const store = new FileStore(dataRoot);
  await store.init();

  const testId = "trial-draft";
  const ir = {
    id: testId,
    version: 1,
    platform: "web" as const,
    steps: [{ id: "open", action: "navigate" as const, path: "/" }],
    assertions: [{ id: "ok", type: "ui" as const, contains: "saved", oracle: "human-approved" as const }],
  };
  await store.saveTest({
    id: testId,
    projectId: "default",
    title: "trial",
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
      url: `/api/tests/${testId}/trial-run`,
      payload: {},
    });
    assert.equal(missing.statusCode, 400);
    assert.match(String(missing.json().error ?? ""), /试跑需要提交 ir/);

    const mismatch = await app.inject({
      method: "POST",
      url: `/api/tests/${testId}/trial-run`,
      payload: { ir: { ...ir, id: "other-id" } },
    });
    assert.equal(mismatch.statusCode, 400);
    assert.match(String(mismatch.json().error ?? ""), /ir\.id/);

    const invalid = await app.inject({
      method: "POST",
      url: `/api/tests/${testId}/trial-run`,
      payload: { ir: { ...ir, steps: [] } },
    });
    assert.equal(invalid.statusCode, 400);
    assert.ok(Array.isArray(invalid.json().issues));
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

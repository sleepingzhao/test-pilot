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

function approvedTest(id: string, contains: string): StoredTest {
  const ir: TestIR = {
    id,
    version: 1,
    platform: "web",
    steps: [{ id: "open", action: "navigate", path: "/" }],
    assertions: [{ id: "a", type: "ui", contains, oracle: "human-approved" }],
  };
  return {
    id,
    projectId: "default",
    title: id,
    ir,
    approvalStatus: "approved",
    approvedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("test list and metrics expose weak approved assertions", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-quality-"));
  const dataRoot = join(root, "data");
  const store = new FileStore(dataRoot);
  await store.init();
  await store.saveTest(approvedTest("weak-approved", "工单"));
  await store.saveTest(approvedTest("strong-approved", "工单已提交"));

  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, join(root, "artifacts"), dataRoot);
  await app.ready();
  try {
    const list = await app.inject({ method: "GET", url: "/api/projects/default/tests" });
    assert.equal(list.statusCode, 200);
    const tests = list.json() as Array<{ id: string; weakAssertions: Array<{ message: string }> }>;
    const weak = tests.find((t) => t.id === "weak-approved");
    const strong = tests.find((t) => t.id === "strong-approved");
    assert.equal(weak?.weakAssertions.length, 1);
    assert.match(weak?.weakAssertions[0]?.message ?? "", /过弱/);
    assert.equal(strong?.weakAssertions.length, 0);

    const summary = await app.inject({ method: "GET", url: "/api/metrics/summary" });
    assert.equal(summary.statusCode, 200);
    const metrics = summary.json() as {
      weakApprovedCount: number;
      weakApprovedTests: Array<{ id: string; count: number }>;
    };
    assert.equal(metrics.weakApprovedCount, 1);
    assert.deepEqual(metrics.weakApprovedTests.map((t) => t.id), ["weak-approved"]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRoutes } from "./routes.js";
import { FileStore } from "./store.js";

test("POST /api/requirement-flow requires text (negative)", async () => {
  const root = await mkdtemp(join(tmpdir(), "tp-req-"));
  const store = new FileStore(join(root, "data"));
  await store.init();
  const app = Fastify();
  await registerRoutes(app, store, join(root, "artifacts"), join(root, "data"));
  const res = await app.inject({
    method: "POST",
    url: "/api/requirement-flow",
    payload: { target: "demo" },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("requirement job reports progress and exposes validation failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "tp-req-job-"));
  const store = new FileStore(join(root, "data"));
  await store.init();
  const app = Fastify();
  await registerRoutes(app, store, join(root, "artifacts"), join(root, "data"));
  try {
    const start = await app.inject({
      method: "POST",
      url: "/api/requirement-flow/jobs",
      payload: { target: "demo" },
    });
    assert.equal(start.statusCode, 202);
    const { jobId } = start.json() as { jobId: string };
    let job: { status: string; error?: string; stage: string } = { status: "running", stage: "" };
    for (let i = 0; i < 50; i++) {
      const res = await app.inject({ method: "GET", url: `/api/requirement-flow/jobs/${jobId}` });
      job = res.json() as typeof job;
      if (job.status !== "running") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(job.status, "failed");
    assert.match(job.error ?? "", /需求描述/);
  } finally {
    await app.close();
  }
});

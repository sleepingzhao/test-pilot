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

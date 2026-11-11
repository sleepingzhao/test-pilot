import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestIR } from "@testpilot/test-ir";
import { runTestIR } from "./run.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

test("a click can capture a UI-triggered response for teardown", async () => {
  const deleted: string[] = [];
  let uploads = 0;
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/upload") {
      uploads += 1;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "rec-42", name: "sample.png" }));
      return;
    }
    if (req.method === "DELETE" && req.url === "/api/records/rec-42") {
      deleted.push("rec-42");
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<!doctype html><body><button id="upload" onclick="fetch('/api/upload',{method:'POST'})">upload</button></body>`,
    );
  });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const ir: TestIR = {
    id: "ui-response-capture",
    version: 1,
    platform: "web",
    baseUrl,
    policy: { screenshots: "never", cleanup: "always" },
    steps: [
      { id: "open", action: "navigate", path: "/" },
      {
        id: "upload",
        action: "click",
        target: { css: "#upload" },
        saveFromRef: "upload-create",
        saveFields: { createdId: "id" },
      },
    ],
    assertions: [
      {
        id: "upload-created",
        type: "api",
        provider: "captured-http",
        requestRef: "upload-create",
        expect: { statusCode: 201 },
        oracle: "api-contract",
      },
    ],
    teardownSteps: [
      {
        id: "cleanup",
        action: "request",
        method: "DELETE",
        path: "/api/records/{{createdId}}",
      },
    ],
  };
  const artifactsDir = await mkdtemp(join(tmpdir(), "testpilot-ui-response-"));
  try {
    const run = await runTestIR(ir, {
      env: {
        baseUrl,
        requestRefs: { "upload-create": { urlIncludes: "/api/upload", method: "POST" } },
      },
      headless: true,
      runId: "ui-response-capture",
      artifactsDir,
    });
    assert.equal(run.status, "passed", JSON.stringify(run.assertions));
    assert.equal(uploads, 1);
    assert.deepEqual(deleted, ["rec-42"]);
    assert.equal(run.cleanup?.status, "passed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

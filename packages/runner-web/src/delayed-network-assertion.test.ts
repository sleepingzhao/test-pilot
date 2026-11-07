import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runTestIR } from "./run.js";

test("waits for a click's delayed request before HTTP assertions", async () => {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/save") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html>
<div role="alert">Saved</div>
<button id="go">submit</button>
<script>
document.getElementById("go").addEventListener("click", () => {
  setTimeout(() => { fetch("/api/save", { method: "POST", body: "ok" }); }, 1200);
});
</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const dir = await mkdtemp(join(tmpdir(), "testpilot-delayed-network-"));

  try {
    const run = await runTestIR(
      {
        id: "delayed-network",
        version: 1,
        platform: "web",
        baseUrlRef: "local",
        steps: [
          { id: "open", action: "navigate", path: "/" },
          { id: "submit", action: "click", target: { css: "#go" } },
        ],
        assertions: [
          {
            id: "saved",
            type: "api",
            provider: "captured-http",
            requestRef: "slow-save",
            expect: { statusCode: 200 },
            oracle: "api-contract",
          },
        ],
      },
      {
        headless: true,
        env: {
          baseUrl: `http://127.0.0.1:${port}`,
          baseUrlRefs: { local: `http://127.0.0.1:${port}` },
          requestRefs: { "slow-save": { urlIncludes: "/api/save", method: "POST" } },
        },
        artifactsDir: dir,
      },
    );
    assert.equal(run.status, "passed");
    assert.equal(run.assertions[0]?.passed, true);
    assert.ok(run.finalSignals?.includes("Saved"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("waits for a click's in-flight request before UI assertions", async () => {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/save") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }, 500);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html>
<div id="msg"></div>
<button id="go">submit</button>
<script>
document.getElementById("go").addEventListener("click", () => {
  fetch("/api/save", { method: "POST", body: "ok" })
    .then((r) => r.text())
    .then(() => { setTimeout(() => { document.getElementById("msg").textContent = "Submitted successfully"; }, 400); });
});
</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const dir = await mkdtemp(join(tmpdir(), "testpilot-inflight-ui-"));

  try {
    const run = await runTestIR(
      {
        id: "inflight-ui",
        version: 1,
        platform: "web",
        baseUrlRef: "local",
        steps: [
          { id: "open", action: "navigate", path: "/" },
          { id: "submit", action: "click", target: { css: "#go" } },
        ],
        assertions: [
          { id: "submitted", type: "ui", contains: "Submitted successfully", oracle: "human-approved" },
        ],
      },
      {
        headless: true,
        env: {
          baseUrl: `http://127.0.0.1:${port}`,
          baseUrlRefs: { local: `http://127.0.0.1:${port}` },
        },
        artifactsDir: dir,
      },
    );
    assert.equal(run.status, "passed");
    assert.equal(run.assertions[0]?.passed, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("UI assertion still fails when the success text never appears", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><p>nothing happened</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const dir = await mkdtemp(join(tmpdir(), "testpilot-ui-negative-"));
  const previous = process.env.TESTPILOT_UI_ASSERT_TIMEOUT_MS;
  process.env.TESTPILOT_UI_ASSERT_TIMEOUT_MS = "600";

  try {
    const run = await runTestIR(
      {
        id: "ui-negative",
        version: 1,
        platform: "web",
        baseUrlRef: "local",
        steps: [{ id: "open", action: "navigate", path: "/" }],
        assertions: [
          { id: "submitted", type: "ui", contains: "Submitted successfully", oracle: "human-approved" },
        ],
      },
      {
        headless: true,
        env: {
          baseUrl: `http://127.0.0.1:${port}`,
          baseUrlRefs: { local: `http://127.0.0.1:${port}` },
        },
        artifactsDir: dir,
      },
    );
    assert.equal(run.status, "failed");
    assert.equal(run.assertions[0]?.passed, false);
    assert.equal(run.assertions[0]?.errorKind, "PRODUCT_DEFECT");
  } finally {
    if (previous === undefined) delete process.env.TESTPILOT_UI_ASSERT_TIMEOUT_MS;
    else process.env.TESTPILOT_UI_ASSERT_TIMEOUT_MS = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an open streaming response does not block the run", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: hello\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><p>ready-text</p><script>fetch("/stream");</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const dir = await mkdtemp(join(tmpdir(), "testpilot-streaming-"));

  try {
    const run = await Promise.race([
      runTestIR(
        {
          id: "streaming-response",
          version: 1,
          platform: "web",
          baseUrlRef: "local",
          steps: [{ id: "open", action: "navigate", path: "/" }],
          assertions: [{ id: "ready", type: "ui", contains: "ready-text", oracle: "human-approved" }],
        },
        {
          headless: true,
          env: {
            baseUrl: `http://127.0.0.1:${port}`,
            baseUrlRefs: { local: `http://127.0.0.1:${port}` },
          },
          artifactsDir: dir,
        },
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("run hung on streaming response")), 20_000),
      ),
    ]);
    assert.equal(run.status, "passed");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

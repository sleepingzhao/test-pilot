import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BrowserContext, Page } from "playwright";
import type { TestIR } from "@testpilot/test-ir";
import { WebSocketServer, type WebSocket } from "ws";
import { runTestIR } from "./run.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

type ServerMetrics = {
  getCount: number;
  postCount: number;
  deleteCount: number;
  loginPostCount: number;
  wsClientMessages: string[];
};

function createReadOnlyFixture(): { server: Server; metrics: ServerMetrics } {
  const metrics: ServerMetrics = { getCount: 0, postCount: 0, deleteCount: 0, loginPostCount: 0, wsClientMessages: [] };
  const server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "/";
      if (url === "/login" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><body>
          <form method="POST" action="/login">
            <input name="password" type="password" />
            <button type="submit">登录</button>
          </form>
        </body>`);
        return;
      }
      if (url === "/login" && req.method === "POST") {
        metrics.loginPostCount += 1;
        await readBody(req);
        res.writeHead(302, { location: "/" });
        res.end();
        return;
      }
      if (url === "/api/ping" && req.method === "GET") {
        metrics.getCount += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url === "/api/write" && req.method === "POST") {
        metrics.postCount += 1;
        await readBody(req);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ saved: true }));
        return;
      }
      if (url === "/api/write" && req.method === "DELETE") {
        metrics.deleteCount += 1;
        res.writeHead(204);
        res.end();
        return;
      }
      if (url === "/" && req.method === "GET") {
        metrics.getCount += 1;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><body>
          <h1>read-only-fixture</h1>
          <button id="post-btn" data-testid="post-btn">写请求</button>
          <button id="ws-send" data-testid="ws-send">WS 发送</button>
          <input id="file" type="file" data-testid="file-input" />
          <script>
            document.getElementById("post-btn").addEventListener("click", () => {
              fetch("/api/write", { method: "POST", body: "x" }).catch(() => {});
            });
            const ws = new WebSocket("ws://" + location.host + "/ws");
            document.getElementById("ws-send").addEventListener("click", () => {
              ws.send("hello-readonly");
            });
          </script>
        </body>`);
        return;
      }
      res.writeHead(404);
      res.end();
    })();
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw: WebSocket.RawData) => {
      metrics.wsClientMessages.push(String(raw));
    });
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => wss.emit("connection", ws, req));
      return;
    }
    socket.destroy();
  });

  return { server, metrics };
}

async function fakeLogin(page: Page, _context: BrowserContext, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => u.pathname === "/", { timeout: 10_000 });
}

function baseIr(baseUrl: string, steps: TestIR["steps"]): TestIR {
  return {
    id: "read-only",
    version: 1,
    platform: "web",
    baseUrl,
    steps,
    assertions: [{ id: "ok", type: "ui", contains: "read-only-fixture", oracle: "human-approved" }],
    policy: { screenshots: "never" },
  };
}

test("readOnlyNetwork: GET request step succeeds; POST fails before network", async () => {
  const { server, metrics } = createReadOnlyFixture();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const artifactsDir = await mkdtemp(join(tmpdir(), "tp-readonly-"));
  try {
    const run = await runTestIR(
      baseIr(baseUrl, [
        { id: "get", action: "request", method: "GET", path: "/api/ping" },
        { id: "post", action: "request", method: "POST", path: "/api/write", body: { x: 1 } },
      ]),
      { env: { baseUrl }, headless: true, artifactsDir, readOnlyNetwork: true },
    );
    assert.equal(run.status, "failed");
    assert.equal(metrics.postCount, 0);
    assert.ok(metrics.getCount >= 1);
    const postStep = run.steps.find((s) => s.stepId === "post");
    assert.equal(postStep?.status, "failed");
    assert.match(postStep?.message ?? "", /只读模式：已阻止写请求 POST/);
    assert.equal(postStep?.durationMs, 0);
    assert.equal(run.metrics.failureKind, "ENVIRONMENT");
    assert.equal(run.readOnly, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("readOnlyNetwork: upload step fails without touching the server", async () => {
  const { server, metrics } = createReadOnlyFixture();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const artifactsDir = await mkdtemp(join(tmpdir(), "tp-readonly-upload-"));
  try {
    const run = await runTestIR(
      {
        ...baseIr(baseUrl, [
          { id: "open", action: "navigate", path: "/" },
          {
            id: "up",
            action: "upload",
            target: { testId: "file-input" },
            valueRef: "fixture.sampletxt",
          },
        ]),
        assertions: [],
      },
      { env: { baseUrl, fixtureDir: artifactsDir }, headless: true, artifactsDir, readOnlyNetwork: true },
    );
    assert.equal(run.status, "failed");
    assert.equal(metrics.postCount, 0);
    const up = run.steps.find((s) => s.stepId === "up");
    assert.match(up?.message ?? "", /只读模式：已阻止文件上传/);
    assert.equal(run.metrics.failureKind, "ENVIRONMENT");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("readOnlyNetwork: click-initiated POST is aborted by route guard", async () => {
  const { server, metrics } = createReadOnlyFixture();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(
      baseIr(baseUrl, [
        { id: "open", action: "navigate", path: "/" },
        { id: "click-post", action: "click", target: { testId: "post-btn" } },
      ]),
      { env: { baseUrl }, headless: true, readOnlyNetwork: true },
    );
    assert.equal(run.status, "passed");
    assert.equal(metrics.postCount, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("readOnlyNetwork: assertion failure after a blocked UI write is ENVIRONMENT", async () => {
  const { server, metrics } = createReadOnlyFixture();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(
      {
        ...baseIr(baseUrl, [
          { id: "open", action: "navigate", path: "/" },
          { id: "click-post", action: "click", target: { testId: "post-btn" } },
        ]),
        assertions: [{ id: "saved", type: "ui", contains: "saved", oracle: "human-approved" }],
      },
      { env: { baseUrl }, headless: true, readOnlyNetwork: true },
    );
    assert.equal(run.status, "failed");
    assert.equal(metrics.postCount, 0);
    assert.ok((run.readOnlyBlockedRequests ?? 0) > 0);
    assert.equal(run.metrics.failureKind, "ENVIRONMENT");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("readOnlyNetwork: teardown request step cannot bypass the guard", async () => {
  const { server, metrics } = createReadOnlyFixture();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(
      {
        ...baseIr(baseUrl, [{ id: "open", action: "navigate", path: "/" }]),
        policy: { screenshots: "never", cleanup: "always" },
        teardownSteps: [{ id: "cleanup", action: "request", method: "DELETE", path: "/api/write" }],
      },
      { env: { baseUrl }, headless: true, readOnlyNetwork: true },
    );
    assert.equal(metrics.deleteCount, 0);
    assert.equal(run.status, "failed");
    assert.equal(run.cleanup?.status, "failed");
    assert.equal(run.cleanup?.steps[0]?.status, "failed");
    assert.match(run.cleanup?.steps[0]?.message ?? "", /只读模式：已阻止写请求 DELETE/);
    assert.equal(run.metrics.failureKind, "ENVIRONMENT");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("readOnlyNetwork: WebSocket send is blocked", async () => {
  const { server, metrics } = createReadOnlyFixture();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(
      {
        ...baseIr(baseUrl, [
          { id: "open", action: "navigate", path: "/" },
          { id: "send-ws", action: "click", target: { testId: "ws-send" } },
        ]),
        assertions: [],
      },
      { env: { baseUrl }, headless: true, readOnlyNetwork: true },
    );
    assert.equal(metrics.wsClientMessages.length, 0);
    assert.equal(run.steps.find((s) => s.stepId === "send-ws")?.status, "passed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("readOnlyNetwork false: POST request step reaches the server", async () => {
  const { server, metrics } = createReadOnlyFixture();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(
      {
        ...baseIr(baseUrl, [
          { id: "post", action: "request", method: "POST", path: "/api/write", body: { ok: true } },
        ]),
        assertions: [],
      },
      { env: { baseUrl }, headless: true, readOnlyNetwork: false },
    );
    assert.equal(run.status, "passed");
    assert.equal(metrics.postCount, 1);
    assert.equal(run.readOnly, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("login hook POST completes before read-only guard blocks test POST", async () => {
  const { server, metrics } = createReadOnlyFixture();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(
      baseIr(baseUrl, [
        { id: "blocked", action: "request", method: "POST", path: "/api/write", body: "nope" },
      ]),
      { env: { baseUrl }, headless: true, readOnlyNetwork: true, login: fakeLogin },
    );
    assert.equal(run.status, "failed");
    assert.equal(metrics.loginPostCount, 1);
    assert.equal(metrics.postCount, 0);
    assert.equal(run.metrics.failureKind, "ENVIRONMENT");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("realTarget evidence policy drops screenshots, trace, and response bodies", async () => {
  const { server, metrics } = createReadOnlyFixture();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const artifactsDir = await mkdtemp(join(tmpdir(), "tp-real-evidence-"));
  try {
    const run = await runTestIR(
      {
        ...baseIr(baseUrl, [
          { id: "open", action: "navigate", path: "/" },
          { id: "click-post", action: "click", target: { testId: "post-btn" } },
        ]),
        policy: { screenshots: "always" },
      },
      { env: { baseUrl }, headless: true, artifactsDir, realTarget: true },
    );
    assert.equal(run.status, "passed");
    assert.equal(metrics.postCount, 1);
    assert.equal(run.realTarget, true);
    assert.ok(!run.artifacts.artifacts.some((item) => item.kind === "screenshot"));
    assert.ok(!run.artifacts.artifacts.some((item) => item.kind === "trace"));
    const network = JSON.parse(await readFile(join(artifactsDir, run.runId, "network.json"), "utf8")) as Array<
      Record<string, unknown>
    >;
    assert.ok(network.length > 0);
    for (const entry of network) {
      assert.equal(entry.responseBody, undefined);
      assert.equal(entry.responseHeaders, undefined);
      assert.equal(entry.requestBody, undefined);
      assert.equal(String(entry.url).includes("?"), false);
    }
    const manifest = JSON.parse(await readFile(join(artifactsDir, run.runId, "manifest.json"), "utf8")) as {
      privacy?: string;
      stepScreenshots: unknown[];
    };
    assert.match(manifest.privacy ?? "", /real-target/);
    assert.equal(manifest.stepScreenshots.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

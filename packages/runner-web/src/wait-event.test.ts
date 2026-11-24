import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import type { TestIR } from "@testpilot/test-ir";
import { runTestIR } from "./run.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

async function stopServer(server: Server, wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function startServer(): Promise<{ server: Server; wss: WebSocketServer; baseUrl: string }> {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (socket: WebSocket) => {
    socket.send("peer-hello");
  });
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/ws-page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><body><h1>ws-fixture</h1>
        <script>
          const ws = new WebSocket("ws://" + location.host + "/ws");
          ws.onmessage = (event) => { window.__peer = event.data; };
        </script></body>`);
      return;
    }
    if (url === "/sse-page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><body><h1>sse-fixture</h1>
        <script>new EventSource("/sse");</script></body>`);
      return;
    }
    if (url === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end("data: hello-sse\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><body><h1>wait-fixture</h1></body>");
  });
  server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client, req));
  });
  const port = await listen(server);
  return { server, wss, baseUrl: `http://127.0.0.1:${port}` };
}

function ir(baseUrl: string, otherActorPath: string, waitForEvent: NonNullable<TestIR["steps"][number]["waitForEvent"]>): TestIR {
  return {
    id: "wait-event",
    version: 1,
    platform: "web",
    baseUrl,
    actors: [{ id: "primary" }, { id: "b", account: "alt" }],
    steps: [
      { id: "open-primary", action: "navigate", path: "/" },
      { id: "open-b", action: "navigate", path: otherActorPath, actor: "b" },
      { id: "wait-peer", action: "waitForEvent", actor: "b", waitForEvent },
    ],
    assertions: [{ id: "ok", type: "ui", contains: "wait-fixture", oracle: "human-approved" }],
    policy: { screenshots: "never" },
  };
}

test("waitForEvent sees a WebSocket frame received by another actor", async () => {
  const { server, wss, baseUrl } = await startServer();
  const artifactsDir = await mkdtemp(join(tmpdir(), "tp-wait-ws-"));
  try {
    const run = await runTestIR(ir(baseUrl, "/ws-page", { direction: "received", contains: "peer-hello", timeoutMs: 5_000 }), {
      env: { baseUrl },
      headless: true,
      artifactsDir,
    });
    assert.equal(run.status, "passed", JSON.stringify(run.steps));
    assert.equal(run.steps.find((step) => step.stepId === "wait-peer")?.status, "passed");
  } finally {
    await stopServer(server, wss);
  }
});

test("waitForEvent sees an SSE event from another actor", async () => {
  const { server, wss, baseUrl } = await startServer();
  const artifactsDir = await mkdtemp(join(tmpdir(), "tp-wait-sse-"));
  try {
    const run = await runTestIR(ir(baseUrl, "/sse-page", { contains: "hello-sse", timeoutMs: 5_000 }), {
      env: { baseUrl },
      headless: true,
      artifactsDir,
    });
    assert.equal(run.status, "passed", JSON.stringify(run.steps));
  } finally {
    await stopServer(server, wss);
  }
});

test("waitForEvent timeout fails as an environment failure", async () => {
  const { server, wss, baseUrl } = await startServer();
  const artifactsDir = await mkdtemp(join(tmpdir(), "tp-wait-timeout-"));
  try {
    const run = await runTestIR(ir(baseUrl, "/ws-page", { contains: "never-arrives", timeoutMs: 1_000 }), {
      env: { baseUrl },
      headless: true,
      artifactsDir,
    });
    assert.equal(run.status, "failed");
    const step = run.steps.find((item) => item.stepId === "wait-peer");
    assert.equal(step?.status, "failed");
    assert.match(step?.message ?? "", /waitForEvent timeout/);
    assert.equal(run.metrics.failureKind, "ENVIRONMENT");
  } finally {
    await stopServer(server, wss);
  }
});

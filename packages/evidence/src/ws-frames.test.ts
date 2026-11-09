import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { WebSocketServer, type RawData } from "ws";
import { createEvidenceCollector } from "./index.js";

const SECRET_EMAIL = "ada.ws@example.com";
const SECRET_PASSWORD = "sekret-ws-pass";
const SECRET_TOKEN = "sekret-ws-token";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function pageHtml(mode: "sample" | "flood"): string {
  if (mode === "flood") {
    return `<!DOCTYPE html><body><script>
      const ws = new WebSocket("ws://" + location.host + "/socket");
      ws.onopen = () => {
        for (let i = 0; i < 250; i++) ws.send("cap-" + i);
        window.__sent = true;
      };
    </script></body>`;
  }
  return `<!DOCTYPE html><body><script>
    const ws = new WebSocket("ws://" + location.host + "/socket?token=${SECRET_TOKEN}");
    ws.binaryType = "arraybuffer";
    ws.onmessage = () => { window.__messages = (window.__messages || 0) + 1; };
    ws.onopen = () => {
      ws.send(JSON.stringify({ password: ${JSON.stringify(SECRET_PASSWORD)}, email: ${JSON.stringify(SECRET_EMAIL)}, text: "hello-ws" }));
      ws.send("Z".repeat(4500));
      window.__opened = true;
    };
  </script></body>`;
}

async function stopServer(started: { server: Server; wss: WebSocketServer }) {
  for (const client of started.wss.clients) client.terminate();
  await new Promise<void>((resolve) => started.wss.close(() => resolve()));
  if (started.server.listening) await close(started.server);
}

function startServer(mode: "sample" | "flood"): Promise<{ server: Server; wss: WebSocketServer; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(pageHtml(mode));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/socket") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      wss.emit("connection", client, req);
    });
  });
  wss.on("connection", (client) => {
    if (mode === "sample") client.send(Buffer.from([0x00, 0x01, 0xff]));
    client.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary || mode === "flood") return;
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : data.toString();
      client.send(text);
    });
  });
  return listen(server).then((port) => ({ server, wss, url: `http://127.0.0.1:${port}/` }));
}

test("captures sent and received frames, truncates payloads, and redacts ws.json", async () => {
  const started = await startServer("sample");
  const dir = await mkdtemp(join(tmpdir(), "testpilot-ws-"));
  const evidence = createEvidenceCollector({ runId: "ws-sample", dir, screenshots: "never" });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await evidence.attachPage(context, page);
    const waiting = evidence.waitForWebSocketFrame(
      (frame) => frame.direction === "received" && frame.payload.includes("hello-ws"),
      5_000,
    );
    await page.goto(started.url);
    assert.equal(await waiting, true);
    await page.waitForFunction("window.__messages >= 2", undefined, { timeout: 5_000 });

    const frames = evidence.getWebSocketFrames();
    const sentHello = frames.find((frame) => frame.direction === "sent" && frame.payload.includes("hello-ws"));
    const receivedHello = frames.find(
      (frame) => frame.direction === "received" && frame.payload.includes("hello-ws"),
    );
    assert.ok(sentHello, "missing sent text frame");
    assert.ok(receivedHello, "missing received text frame");
    assert.equal(sentHello.direction, "sent");
    assert.equal(receivedHello.direction, "received");
    assert.match(sentHello.url, /\/socket\?token=/);
    assert.equal(sentHello.payload.includes(SECRET_EMAIL), true);

    const longSent = frames.find((frame) => frame.direction === "sent" && frame.payload.startsWith("ZZZ"));
    assert.ok(longSent, "missing long sent frame");
    assert.equal(longSent.payload.length, 4000);
    assert.equal(longSent.size, 4500);

    const binary = frames.find((frame) => frame.direction === "received" && frame.payload.startsWith("base64:"));
    assert.ok(binary, "missing binary frame");
    assert.equal(binary.payload, `base64:${Buffer.from([0x00, 0x01, 0xff]).toString("base64")}`);
    assert.equal(binary.size, 3);

    const artifacts = await evidence.finalize("passed");
    assert.ok(artifacts.artifacts.some((item) => item.kind === "ws"));
    const written = await readFile(join(dir, "ws-sample", "ws.json"), "utf8");
    const parsed = JSON.parse(written) as { dropped: number; frames: Array<{ url: string; payload: string }> };
    assert.equal(parsed.dropped, 0);
    const storedHello = parsed.frames.find((frame) => frame.payload.includes("hello-ws"));
    assert.ok(storedHello);
    assert.match(storedHello.payload, /"password":"\*\*\*"/);
    assert.match(storedHello.payload, /"email":"\*\*\*"/);
    assert.equal(written.includes("token=***") || written.includes("token=%2A%2A%2A"), true);
    assert.equal(written.includes(SECRET_TOKEN), false);
    assert.equal(written.includes(SECRET_EMAIL), false);
    assert.equal(written.includes(SECRET_PASSWORD), false);

    const network = JSON.parse(await readFile(join(dir, "ws-sample", "network.json"), "utf8"));
    assert.ok(Array.isArray(network));
  } finally {
    await browser.close();
    await stopServer(started);
  }
});

test("drops websocket frames beyond 200 and records the drop in ws.json", async () => {
  const started = await startServer("flood");
  const dir = await mkdtemp(join(tmpdir(), "testpilot-ws-cap-"));
  const evidence = createEvidenceCollector({ runId: "ws-cap", dir, screenshots: "never" });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await evidence.attachPage(context, page);
    await page.goto(started.url);
    await page.waitForFunction("window.__sent === true", undefined, { timeout: 5_000 });
    const deadline = Date.now() + 5_000;
    while (evidence.getWebSocketFrames().length < 200 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(evidence.getWebSocketFrames().length, 200);
    await evidence.finalize("passed");
    const written = await readFile(join(dir, "ws-cap", "ws.json"), "utf8");
    const parsed = JSON.parse(written) as { dropped: number; note?: string; frames: unknown[] };
    assert.equal(parsed.frames.length, 200);
    assert.ok(parsed.dropped > 0, `expected dropped frames, got ${parsed.dropped}`);
    assert.match(parsed.note ?? "", /dropped \d+ websocket frames beyond the limit of 200/);
  } finally {
    await browser.close();
    await stopServer(started);
  }
});

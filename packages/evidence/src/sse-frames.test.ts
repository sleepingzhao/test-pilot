import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { createEvidenceCollector } from "./index.js";

const SECRET_EMAIL = "ada.sse@example.com";
const SECRET_PASSWORD = "sekret-sse-pass";
const SECRET_TOKEN = "sekret-sse-token";

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

type SseMode = "sample" | "long" | "flood" | "redact" | "infinite" | "json";

function buildSseBody(mode: SseMode): string {
  if (mode === "long") {
    return `data: ${"L".repeat(4500)}\n\n`;
  }
  if (mode === "flood") {
    const chunks: string[] = [];
    for (let i = 0; i < 250; i++) {
      chunks.push(`data: cap-${i}\n\n`);
    }
    return chunks.join("");
  }
  if (mode === "redact") {
    return `data: ${JSON.stringify({ password: SECRET_PASSWORD, email: SECRET_EMAIL, text: "hello-sse" })}\n\n`;
  }
  if (mode === "sample") {
    return [
      'data: {"seq":1,"text":"one"}\n\n',
      'data: {"seq":2,"text":"two"}\n\n',
      'data: {"seq":3,"text":"three"}\n\n',
      "event: done\n\n",
    ].join("");
  }
  return "";
}

function pageHtml(path: string, mode: SseMode): string {
  if (mode === "infinite") {
    return `<!DOCTYPE html><body><script>
      const es = new EventSource("/stream/infinite");
      es.onmessage = () => { window.__ticks = (window.__ticks || 0) + 1; };
    </script></body>`;
  }
  if (mode === "json") {
    return `<!DOCTYPE html><body><p>plain</p></body>`;
  }
  return `<!DOCTYPE html><body><button id="go">go</button><script>
    document.getElementById("go").addEventListener("click", () => {
      const es = new EventSource(${JSON.stringify(path)});
      es.addEventListener("message", () => { window.__messages = (window.__messages || 0) + 1; });
      es.addEventListener("done", () => { window.__done = true; es.close(); });
    });
    </script></body>`;
}

async function startFixture(mode: SseMode): Promise<{ server: Server; url: string; ssePath: string }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/stream/infinite") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      const timer = setInterval(() => {
        res.write("data: tick\n\n");
      }, 40);
      req.on("close", () => {
        clearInterval(timer);
        if (!res.writableEnded) res.end();
      });
      return;
    }
    if (path === "/stream/sample") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.end(buildSseBody("sample"));
      return;
    }
    if (path === "/stream/long") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.end(buildSseBody("long"));
      return;
    }
    if (path === "/stream/flood") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.end(buildSseBody("flood"));
      return;
    }
    if (path === "/stream/redact") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
      });
      res.end(buildSseBody("redact"));
      return;
    }
    if (path === "/api/plain.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (path === "/") {
      const ssePath =
        mode === "sample"
          ? "/stream/sample"
          : mode === "long"
            ? "/stream/long"
            : mode === "flood"
              ? "/stream/flood"
              : `/stream/redact?token=${SECRET_TOKEN}`;
      res.end(pageHtml(ssePath, mode));
      return;
    }
    res.end(pageHtml("/stream/sample", mode));
  });
  const port = await listen(server);
  const ssePath =
    mode === "redact" ? `/stream/redact?token=${SECRET_TOKEN}` : `/stream/${mode === "json" ? "sample" : mode}`;
  return { server, url: `http://127.0.0.1:${port}/`, ssePath };
}

test("captures finite SSE events in order with event names", async () => {
  const started = await startFixture("sample");
  const dir = await mkdtemp(join(tmpdir(), "testpilot-sse-"));
  const evidence = createEvidenceCollector({ runId: "sse-sample", dir, screenshots: "never" });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await evidence.attachPage(context, page);
    await page.goto(started.url);
    await page.click("#go");
    const deadline = Date.now() + 8_000;
    while (evidence.getSseEvents().length < 4 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const events = evidence.getSseEvents();
    assert.equal(events.length, 4);
    assert.deepEqual(
      events.slice(0, 3).map((e) => e.data),
      ['{"seq":1,"text":"one"}', '{"seq":2,"text":"two"}', '{"seq":3,"text":"three"}'],
    );
    assert.equal(events[3]?.event, "done");

    const artifacts = await evidence.finalize("passed");
    assert.ok(artifacts.artifacts.some((item) => item.kind === "sse"));
    const written = JSON.parse(await readFile(join(dir, "sse-sample", "sse.json"), "utf8")) as {
      events: Array<{ data: string; event?: string }>;
    };
    assert.equal(written.events.length, 4);
    assert.equal(written.events[3]?.event, "done");

    const network = JSON.parse(await readFile(join(dir, "sse-sample", "network.json"), "utf8")) as Array<{
      responseBody?: string;
    }>;
    assert.ok(Array.isArray(network));
    assert.equal(network.some((n) => (n.responseBody ?? "").includes("seq")), false);
  } finally {
    await browser.close();
    await close(started.server);
  }
});

test("truncates per-event data beyond 4000 characters", async () => {
  const started = await startFixture("long");
  const dir = await mkdtemp(join(tmpdir(), "testpilot-sse-long-"));
  const evidence = createEvidenceCollector({ runId: "sse-long", dir, screenshots: "never" });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await evidence.attachPage(context, page);
    await page.goto(started.url);
    await page.click("#go");
    await page.waitForFunction("window.__messages >= 1", undefined, { timeout: 5_000 });

    const events = evidence.getSseEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.data.length, 4000);
    assert.match(events[0]?.data ?? "", /^L+$/);

    await evidence.finalize("passed");
    const written = JSON.parse(await readFile(join(dir, "sse-long", "sse.json"), "utf8")) as {
      note?: string;
      events: Array<{ data: string }>;
    };
    assert.equal(written.events[0]?.data.length, 4000);
    assert.match(written.note ?? "", /truncated to 4000/);
  } finally {
    await browser.close();
    await close(started.server);
  }
});

test("drops events beyond 200 and records note", async () => {
  const started = await startFixture("flood");
  const dir = await mkdtemp(join(tmpdir(), "testpilot-sse-flood-"));
  const evidence = createEvidenceCollector({ runId: "sse-flood", dir, screenshots: "never" });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await evidence.attachPage(context, page);
    await page.goto(started.url);
    await page.click("#go");
    await page.waitForFunction("window.__messages >= 1", undefined, { timeout: 5_000 });

    assert.equal(evidence.getSseEvents().length, 200);
    await evidence.finalize("passed");
    const written = JSON.parse(await readFile(join(dir, "sse-flood", "sse.json"), "utf8")) as {
      dropped: number;
      note?: string;
      events: unknown[];
    };
    assert.equal(written.events.length, 200);
    assert.ok(written.dropped > 0);
    assert.match(written.note ?? "", /dropped \d+ sse events beyond the limit of 200/);
  } finally {
    await browser.close();
    await close(started.server);
  }
});

test("redacts token, email, and password patterns in sse.json", async () => {
  const started = await startFixture("redact");
  const dir = await mkdtemp(join(tmpdir(), "testpilot-sse-redact-"));
  const evidence = createEvidenceCollector({ runId: "sse-redact", dir, screenshots: "never" });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await evidence.attachPage(context, page);
    await page.goto(started.url);
    await page.click("#go");
    await page.waitForFunction("window.__messages >= 1", undefined, { timeout: 5_000 });

    await evidence.finalize("passed");
    const written = await readFile(join(dir, "sse-redact", "sse.json"), "utf8");
    const parsed = JSON.parse(written) as { events: Array<{ url: string; data: string }> };
    const stored = parsed.events[0];
    assert.ok(stored);
    const inner = JSON.parse(stored.data) as { password?: string; email?: string };
    assert.equal(inner.password, "***");
    assert.equal(inner.email, "***");
    assert.equal(written.includes(SECRET_TOKEN), false);
    assert.equal(written.includes(SECRET_EMAIL), false);
    assert.equal(written.includes(SECRET_PASSWORD), false);
    assert.match(stored.url, /token=|%2A%2A%2A|token=\*\*\*/);
  } finally {
    await browser.close();
    await close(started.server);
  }
});

test("infinite SSE and ordinary responses do not hang finalize", async () => {
  const started = await startFixture("infinite");
  const dir = await mkdtemp(join(tmpdir(), "testpilot-sse-hang-"));
  const evidence = createEvidenceCollector({ runId: "sse-hang", dir, screenshots: "never" });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await evidence.attachPage(context, page);
    const port = new URL(started.url).port;
    await page.goto(started.url);
    await page.waitForTimeout(200);
    await page.evaluate(async (p) => {
      await fetch(`http://127.0.0.1:${p}/api/plain.json`);
    }, port);
    await evidence.waitForNetworkEntry((n) => n.url.includes("/api/plain.json") && Boolean(n.responseBody), 5_000);

    const start = Date.now();
    await evidence.finalize("passed");
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 8_000, `finalize took ${elapsed}ms`);

    const written = JSON.parse(await readFile(join(dir, "sse-hang", "sse.json"), "utf8")) as {
      events: unknown[];
      dropped: number;
    };
    assert.ok(written.events.length <= 200);
    const network = JSON.parse(await readFile(join(dir, "sse-hang", "network.json"), "utf8")) as Array<{
      responseBody?: string;
    }>;
    assert.equal(network.some((n) => (n.responseBody ?? "").includes('"ok"')), true);
  } finally {
    await browser.close();
    await close(started.server);
  }
});
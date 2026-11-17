import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { chromium } from "playwright";
import type { VisionRuntimeConfig } from "./vision-config.js";
import {
  collectLocatorCandidates,
  locateWithVision,
  suggestLocator,
} from "./vision-locate.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

const fixtureHtml = `<!doctype html><html><body style="margin:24px">
  <button data-testid="add-user">添加用户</button>
  <button aria-label="关闭对话框" style="width:32px;height:32px"></button>
  <input type="password" value="secret" style="width:200px;height:32px" />
  <input type="hidden" name="csrf" value="x" />
  <button disabled style="width:80px;height:32px">不可用</button>
  <div style="position:fixed;left:-200px;top:0"><button>屏外</button></div>
</body></html>`;

test("collectLocatorCandidates prefers stable selectors", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fixtureHtml);
  });
  const port = await listen(server);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    const candidates = await collectLocatorCandidates(page);
    const add = candidates.find((c) => c.testId === "add-user");
    assert.ok(add);
    assert.equal(add?.css, '[data-testid="add-user"]');
    const icon = candidates.find((c) => c.name === "关闭对话框");
    assert.ok(icon);
    assert.equal(candidates.some((c) => c.tag === "input" && c.placeholder === undefined), false);
    assert.equal(candidates.some((c) => c.text === "不可用"), false);
    assert.equal(candidates.some((c) => c.text === "屏外"), false);
    for (const c of candidates) {
      assert.equal(c.css.includes(">"), false);
    }
    const resolved = await page.evaluate(
      (items: Array<{ css: string; tag: string }>) =>
        items.map((item) => {
          const el = document.querySelector(item.css);
          return { css: item.css, ok: Boolean(el), tag: el?.tagName.toLowerCase() };
        }),
      candidates.map((c) => ({ css: c.css, tag: c.tag })),
    );
    for (const item of resolved) {
      assert.equal(item.ok, true, item.css);
      assert.equal(item.tag, candidates.find((c) => c.css === item.css)?.tag, item.css);
    }
  } finally {
    await page.close();
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("locateWithVision calls OpenAI-compatible endpoint with image and candidates", async () => {
  let sawImage = false;
  let sawCandidates = false;
  let authHeader = "";
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      authHeader = req.headers.authorization ?? "";
      const body = JSON.parse(raw) as {
        messages: Array<{ content: Array<{ type: string; image_url?: { url: string }; text?: string }> }>;
      };
      const user = body.messages.find((m) => Array.isArray(m.content));
      const parts = user?.content ?? [];
      sawImage = parts.some((p) => p.type === "image_url" && p.image_url?.url?.startsWith("data:image/jpeg;base64,"));
      sawCandidates = parts.some((p) => p.type === "text" && p.text?.includes("Candidates"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"index": 0, "confidence": 0.9, "reason": "匹配按钮文案"}' } }],
        }),
      );
    });
  });
  const port = await listen(server);
  const config: VisionRuntimeConfig = {
    enabled: true,
    apiKey: "test-vision-secret",
    baseUrl: `http://127.0.0.1:${port}`,
    model: "vision-test",
    timeoutMs: 10_000,
  };
  try {
    const out = await locateWithVision(config, {
      instruction: "添加用户按钮",
      candidates: [
        {
          index: 0,
          tag: "button",
          testId: "add-user",
          text: "添加用户",
          rect: { x: 0, y: 0, width: 80, height: 32 },
          css: '[data-testid="add-user"]',
        },
      ],
      screenshotDataUrl: "data:image/jpeg;base64,AA==",
    });
    assert.ok(!("error" in out));
    assert.equal(out.index, 0);
    assert.equal(out.confidence, 0.9);
    assert.ok(sawImage);
    assert.ok(sawCandidates);
    assert.equal(authHeader.includes("test-vision-secret"), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("locateWithVision handles invalid JSON and HTTP errors safely", async () => {
  const badJson = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "not json" } }] }));
  });
  const portJson = await listen(badJson);
  const config: VisionRuntimeConfig = {
    enabled: true,
    apiKey: "leak-key",
    baseUrl: `http://127.0.0.1:${portJson}`,
    model: "m",
    timeoutMs: 5_000,
  };
  try {
    const out = await locateWithVision(config, {
      instruction: "x",
      candidates: [],
      screenshotDataUrl: "data:image/jpeg;base64,AA==",
    });
    assert.deepEqual(out, { error: "视觉模型返回无法解析" });
  } finally {
    await new Promise<void>((resolve) => badJson.close(() => resolve()));
  }

  const errServer = createServer((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "fail with leak-key" } }));
  });
  const portErr = await listen(errServer);
  const errConfig: VisionRuntimeConfig = { ...config, baseUrl: `http://127.0.0.1:${portErr}` };
  try {
    const out = await locateWithVision(errConfig, {
      instruction: "x",
      candidates: [],
      screenshotDataUrl: "data:image/jpeg;base64,AA==",
    });
    assert.ok("error" in out);
    assert.match(out.error, /HTTP 500/);
    assert.equal(out.error.includes("leak-key"), false);
  } finally {
    await new Promise<void>((resolve) => errServer.close(() => resolve()));
  }
});

test("suggestLocator maps vision index -1 to a user-facing error", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fixtureHtml);
  });
  const htmlPort = await listen(server);

  const model = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: '{"index": -1, "confidence": 0, "reason": "none"}' } }],
      }),
    );
  });
  const modelPort = await listen(model);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const config: VisionRuntimeConfig = {
    enabled: true,
    apiKey: "k",
    baseUrl: `http://127.0.0.1:${modelPort}`,
    model: "m",
    timeoutMs: 10_000,
  };
  try {
    await page.goto(`http://127.0.0.1:${htmlPort}/`);
    const out = await suggestLocator(page, "神秘按钮", config);
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.error, "视觉模型没有找到匹配元素");
  } finally {
    await page.close();
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => model.close(() => resolve()));
  }
});
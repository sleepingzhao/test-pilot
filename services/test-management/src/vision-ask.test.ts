import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { chromium } from "playwright";
import type { VisionRuntimeConfig } from "./vision-config.js";
import { askAboutPage, askWithVision } from "./vision-ask.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

const fixtureHtml = `<!doctype html><html><body style="margin:24px">
  <h1>用户列表</h1>
  <ul><li>Alice</li><li>Bob</li></ul>
</body></html>`;

test("askWithVision parses yes, no, and unclear", async () => {
  const cases: Array<{ content: string; answer: "yes" | "no" | "unclear"; confidence: number }> = [
    { content: '{"answer":"yes","confidence":0.92,"reason":"列表可见"}', answer: "yes", confidence: 0.92 },
    { content: '{"answer":"no","confidence":0.8,"reason":"未见空状态"}', answer: "no", confidence: 0.8 },
    { content: '{"answer":"unclear","confidence":0.1,"reason":"区域被遮挡"}', answer: "unclear", confidence: 0.1 },
  ];
  for (const c of cases) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: c.content } }] }));
    });
    const port = await listen(server);
    const config: VisionRuntimeConfig = {
      enabled: true,
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "ask-test",
      timeoutMs: 10_000,
    };
    try {
      const out = await askWithVision(config, {
        question: "列表是否显示了用户？",
        screenshotDataUrl: "data:image/jpeg;base64,AA==",
      });
      assert.equal(out.ok, true);
      if (out.ok) {
        assert.equal(out.answer, c.answer);
        assert.equal(out.confidence, c.confidence);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test("askWithVision sends image_url and never leaks API key in errors", async () => {
  let sawImage = false;
  let sawQuestion = false;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as {
        max_tokens?: number;
        messages: Array<{ content: Array<{ type: string; image_url?: { url: string }; text?: string }> }>;
      };
      assert.equal(body.max_tokens, 300);
      const user = body.messages.find((m) => Array.isArray(m.content));
      const parts = user?.content ?? [];
      sawImage = parts.some((p) => p.type === "image_url" && p.image_url?.url?.startsWith("data:image/jpeg;base64,"));
      sawQuestion = parts.some((p) => p.type === "text" && p.text === "空状态？");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "not json" } }] }));
    });
  });
  const port = await listen(server);
  const config: VisionRuntimeConfig = {
    enabled: true,
    apiKey: "super-secret-vision-key",
    baseUrl: `http://127.0.0.1:${port}`,
    model: "m",
    timeoutMs: 5_000,
  };
  try {
    const out = await askWithVision(config, {
      question: "空状态？",
      screenshotDataUrl: "data:image/jpeg;base64,BB==",
    });
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.error, "视觉模型返回无法解析");
      assert.equal(out.error.includes("super-secret"), false);
    }
    assert.ok(sawImage);
    assert.ok(sawQuestion);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("askWithVision handles HTTP errors safely", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad-gateway with leak-key" } }));
  });
  const port = await listen(server);
  const config: VisionRuntimeConfig = {
    enabled: true,
    apiKey: "leak-key",
    baseUrl: `http://127.0.0.1:${port}`,
    model: "m",
    timeoutMs: 5_000,
  };
  try {
    const out = await askWithVision(config, {
      question: "x",
      screenshotDataUrl: "data:image/jpeg;base64,AA==",
    });
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.match(out.error, /HTTP 502/);
      assert.equal(out.error.includes("leak-key"), false);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("askAboutPage captures screenshot and calls vision model", async () => {
  const htmlServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fixtureHtml);
  });
  const htmlPort = await listen(htmlServer);

  const modelServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '{"answer":"yes","confidence":0.88,"reason":"标题为用户列表且有两条记录"}',
            },
          },
        ],
      }),
    );
  });
  const modelPort = await listen(modelServer);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const config: VisionRuntimeConfig = {
    enabled: true,
    apiKey: "k",
    baseUrl: `http://127.0.0.1:${modelPort}`,
    model: "vision-ask-model",
    timeoutMs: 10_000,
  };
  try {
    await page.goto(`http://127.0.0.1:${htmlPort}/`);
    const out = await askAboutPage(page, "页面是否显示了用户列表？", config);
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.answer, "yes");
      assert.equal(out.model, "vision-ask-model");
      assert.ok(out.reason.length > 0);
    }
  } finally {
    await page.close();
    await browser.close();
    await new Promise<void>((resolve) => htmlServer.close(() => resolve()));
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
});
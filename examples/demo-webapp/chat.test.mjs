import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";
import { WebSocket } from "ws";
import { createDemoServer } from "./server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try {
  chromium = createRequire(join(here, "../../packages/runner-web/package.json"))("playwright").chromium;
} catch {
  chromium = undefined;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function openSocket(url) {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a chat frame")), timeoutMs);
    ws.once("message", (data, isBinary) => {
      clearTimeout(timer);
      if (isBinary) {
        reject(new Error("unexpected binary frame"));
        return;
      }
      resolve(JSON.parse(data.toString()));
    });
  });
}

describe("demo /ws/chat", { concurrency: 1 }, () => {
  /** @type {import("node:http").Server} */
  let server;
  let base;

  test.before(async () => {
    delete process.env.DEMO_CHAT_DROP;
    server = createDemoServer();
    const port = await listen(server);
    base = `http://127.0.0.1:${port}`;
  });

  test.after(async () => {
    delete process.env.DEMO_CHAT_DROP;
    await close(server);
  });

  test("GET / index nav links to /chat", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /href="\/chat"/);
  });

  test("GET /chat serves the composer", async () => {
    const res = await fetch(`${base}/chat`);
    assert.equal(res.status, 200);
    const html = await res.text();
    for (const id of ["chat-status", "chat-list", "chat-composer", "chat-send", "chat-send-image"]) {
      assert.equal(html.includes(`data-testid="${id}"`), true, id);
    }
    assert.equal(html.includes("测试用户"), true);
    assert.equal(html.includes("已连接"), true);
    assert.equal(html.includes("未连接"), true);
  });

  const VALID_IMAGE_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFgAI/Al6c3wAAAABJRU5ErkJggg==";

  test("broadcasts a valid image to sender and a second client", async () => {
    const sender = await openSocket(base.replace("http", "ws") + "/ws/chat");
    const receiver = await openSocket(base.replace("http", "ws") + "/ws/chat");
    try {
      const heard = Promise.all([nextMessage(sender), nextMessage(receiver)]);
      sender.send(
        JSON.stringify({
          type: "image",
          user: "甲",
          dataUrl: VALID_IMAGE_DATA_URL,
          name: "测试图片.png",
        }),
      );
      const [left, right] = await heard;
      assert.equal(left.type, "image");
      assert.equal(right.type, "image");
      assert.equal(left.user, "甲");
      assert.equal(left.dataUrl, VALID_IMAGE_DATA_URL);
      assert.equal(right.dataUrl, VALID_IMAGE_DATA_URL);
      assert.equal(left.id, right.id);
      assert.equal(left.name, "测试图片.png");
    } finally {
      sender.close();
      receiver.close();
    }
  });

  test("bad_image goes only to sender without broadcast", async () => {
    const sender = await openSocket(base.replace("http", "ws") + "/ws/chat");
    const listener = await openSocket(base.replace("http", "ws") + "/ws/chat");
    let listenerHeard = false;
    listener.on("message", () => {
      listenerHeard = true;
    });
    try {
      const errorPromise = nextMessage(sender);
      sender.send(JSON.stringify({ type: "image", user: "甲", dataUrl: "not-an-image" }));
      const err = await errorPromise;
      assert.deepEqual(err, {
        type: "error",
        code: "bad_image",
        message: "图片消息无效",
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(listenerHeard, false);
    } finally {
      sender.close();
      listener.close();
    }
  });

  test("missing dataUrl returns bad_image only to sender", async () => {
    const sender = await openSocket(base.replace("http", "ws") + "/ws/chat");
    const listener = await openSocket(base.replace("http", "ws") + "/ws/chat");
    let listenerHeard = false;
    listener.on("message", () => {
      listenerHeard = true;
    });
    try {
      const errorPromise = nextMessage(sender);
      sender.send(JSON.stringify({ type: "image", user: "甲" }));
      const err = await errorPromise;
      assert.equal(err.code, "bad_image");
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(listenerHeard, false);
    } finally {
      sender.close();
      listener.close();
    }
  });

  test("broadcasts a text message to every connection", async () => {
    const alice = await openSocket(base.replace("http", "ws") + "/ws/chat");
    const bob = await openSocket(base.replace("http", "ws") + "/ws/chat");
    try {
      const heard = Promise.all([nextMessage(alice), nextMessage(bob)]);
      alice.send(JSON.stringify({ type: "message", user: "甲", text: "你好" }));
      const [left, right] = await heard;
      assert.deepEqual(
        [left, right].map((msg) => ({ type: msg.type, user: msg.user, text: msg.text })),
        [
          { type: "message", user: "甲", text: "你好" },
          { type: "message", user: "甲", text: "你好" },
        ],
      );
      assert.equal(left.id, right.id);
      assert.equal(typeof left.id, "string");
      assert.equal(typeof left.at, "string");
    } finally {
      alice.close();
      bob.close();
    }
  });

  test("?drop=1 accepts the message and does not broadcast it", async () => {
    const listener = await openSocket(base.replace("http", "ws") + "/ws/chat");
    const dropper = await openSocket(base.replace("http", "ws") + "/ws/chat?drop=1");
    let heard = false;
    listener.on("message", () => {
      heard = true;
    });
    dropper.on("message", () => {
      heard = true;
    });
    try {
      dropper.send(JSON.stringify({ type: "message", user: "甲", text: "不要发出去" }));
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(heard, false);
    } finally {
      listener.close();
      dropper.close();
    }
  });

  test("DEMO_CHAT_DROP=1 accepts the message and does not broadcast it", async () => {
    process.env.DEMO_CHAT_DROP = "1";
    const listener = await openSocket(base.replace("http", "ws") + "/ws/chat");
    let heard = false;
    listener.on("message", () => {
      heard = true;
    });
    try {
      listener.send(JSON.stringify({ type: "message", user: "甲", text: "环境丢弃" }));
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(heard, false);
    } finally {
      delete process.env.DEMO_CHAT_DROP;
      listener.close();
    }
  });

  test("ignores binary frames", async () => {
    const listener = await openSocket(base.replace("http", "ws") + "/ws/chat");
    let heard = false;
    listener.on("message", () => {
      heard = true;
    });
    try {
      listener.send(Buffer.from([1, 2, 3]));
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(heard, false);
    } finally {
      listener.close();
    }
  });

  test("returns too_long to sender and does not broadcast overlong text", async () => {
    const sender = await openSocket(base.replace("http", "ws") + "/ws/chat");
    const listener = await openSocket(base.replace("http", "ws") + "/ws/chat");
    let listenerHeard = false;
    listener.on("message", () => {
      listenerHeard = true;
    });
    try {
      const longText = "长".repeat(201);
      const errorPromise = nextMessage(sender);
      sender.send(JSON.stringify({ type: "message", user: "甲", text: longText }));
      const err = await errorPromise;
      assert.deepEqual(err, {
        type: "error",
        code: "too_long",
        message: "消息过长（最多 200 字）",
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(listenerHeard, false);
    } finally {
      sender.close();
      listener.close();
    }
  });

  test("chat page shows oversize error in list and status", async (t) => {
    if (!chromium) {
      t.skip("playwright not available");
      return;
    }
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.goto(`${base}/chat`);
      await page.getByTestId("chat-status").waitFor();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="chat-status"]')?.textContent === "已连接",
        undefined,
        { timeout: 5_000 },
      );
      const longText = "页".repeat(201);
      await page.getByTestId("chat-composer").fill(longText);
      await page.getByTestId("chat-send").click();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('[data-testid="chat-list"] li')].some((li) =>
            li.textContent?.includes("消息过长"),
          ),
        undefined,
        { timeout: 5_000 },
      );
      const status = await page.textContent('[data-testid="chat-status"]');
      assert.equal(status, "发送失败：消息过长");
      const listText = await page.textContent('[data-testid="chat-list"]');
      assert.match(listText ?? "", /消息过长（最多 200 字）/);
      assert.doesNotMatch(listText ?? "", new RegExp(longText.slice(0, 20)));
    } finally {
      await browser.close();
    }
  });

  test("chat page script handles server error frames", async () => {
    const html = await readFile(join(here, "chat.html"), "utf8");
    assert.match(html, /msg\.type === "error"/);
    assert.match(html, /发送失败：消息过长/);
  });

  test("rejects upgrades that are not /ws/chat", async () => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws/other");
    const result = await new Promise((resolve) => {
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode));
      ws.once("open", () => resolve("open"));
      ws.once("error", () => resolve("error"));
    });
    assert.equal(result, 404);
    ws.close();
  });
});

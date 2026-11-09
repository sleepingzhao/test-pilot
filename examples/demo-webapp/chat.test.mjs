import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { WebSocket } from "ws";
import { createDemoServer } from "./server.mjs";

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

  test("GET /chat serves the composer", async () => {
    const res = await fetch(`${base}/chat`);
    assert.equal(res.status, 200);
    const html = await res.text();
    for (const id of ["chat-status", "chat-list", "chat-composer", "chat-send"]) {
      assert.equal(html.includes(`data-testid="${id}"`), true, id);
    }
    assert.equal(html.includes("测试用户"), true);
    assert.equal(html.includes("已连接"), true);
    assert.equal(html.includes("未连接"), true);
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

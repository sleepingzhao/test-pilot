import assert from "node:assert/strict";
import test, { describe } from "node:test";
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

describe("demo /api/sse", { concurrency: 1 }, () => {
  /** @type {import("node:http").Server} */
  let server;
  let base;

  test.before(async () => {
    server = createDemoServer();
    const port = await listen(server);
    base = `http://127.0.0.1:${port}`;
  });

  test.after(async () => {
    await close(server);
  });

  test("GET /sse serves the start control", async () => {
    const res = await fetch(`${base}/sse`);
    assert.equal(res.status, 200);
    const html = await res.text();
    for (const id of ["sse-status", "sse-list", "sse-start"]) {
      assert.equal(html.includes(`data-testid="${id}"`), true, id);
    }
  });

  test("GET /api/sse returns three data lines then closes", async () => {
    const res = await fetch(`${base}/api/sse`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/i);
    const body = await res.text();
    const dataLines = body
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    assert.deepEqual(dataLines.slice(0, 3), [
      '{"seq":1,"text":"测试sse-1"}',
      '{"seq":2,"text":"测试sse-2"}',
      '{"seq":3,"text":"测试sse-3"}',
    ]);
    assert.equal(body.includes("event: done"), true);
  });
});
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestIR } from "@testpilot/test-ir";
import { runTestIR } from "./run.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

function createFrameServer(): Server {
  return createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/inner") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><body>
        <input placeholder="搜索" />
        <button id="member">陈佳行</button>
        <div id="result">联系人列表</div>
        <script>
          document.getElementById("member").addEventListener("click", () => {
            document.getElementById("result").textContent = "已选中 陈佳行";
          });
        </script>
      </body>`);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><body>
      <h1>通讯录</h1>
      <iframe name="inner" src="/inner"></iframe>
    </body>`);
  });
}

function frameIr(baseUrl: string, steps: TestIR["steps"], assertions: TestIR["assertions"]): TestIR {
  return { id: "frame-ir", version: 1, platform: "web", baseUrl, steps, assertions, policy: { screenshots: "never" } };
}

test("steps and UI assertions resolve inside the declared iframe", async () => {
  const server = createFrameServer();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const artifactsDir = await mkdtemp(join(tmpdir(), "tp-frame-"));
  try {
    const run = await runTestIR(
      frameIr(
        baseUrl,
        [
          { id: "open", action: "navigate", path: "/" },
          { id: "search", action: "fill", frame: 'iframe[name="inner"]', target: { placeholder: "搜索" }, value: "陈" },
          { id: "pick", action: "click", frame: 'iframe[name="inner"]', target: { name: "陈佳行" } },
        ],
        [
          {
            id: "picked",
            type: "ui",
            frame: 'iframe[name="inner"]',
            contains: "已选中 陈佳行",
            oracle: "human-approved",
          },
        ],
      ),
      { env: { baseUrl }, headless: true, artifactsDir },
    );
    assert.equal(run.status, "passed", JSON.stringify(run.steps));
    assert.equal(run.assertions[0]?.passed, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a target without a frame does not silently fall through to the iframe", async () => {
  const server = createFrameServer();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const artifactsDir = await mkdtemp(join(tmpdir(), "tp-frame-neg-"));
  try {
    const run = await runTestIR(
      frameIr(
        baseUrl,
        [
          { id: "open", action: "navigate", path: "/" },
          { id: "pick", action: "click", target: { name: "陈佳行" } },
        ],
        [],
      ),
      { env: { baseUrl }, headless: true, artifactsDir },
    );
    assert.equal(run.status, "failed");
    assert.match(run.steps.find((s) => s.stepId === "pick")?.message ?? "", /locator not found/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

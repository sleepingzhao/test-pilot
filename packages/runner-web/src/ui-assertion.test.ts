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
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

function server(): Server {
  return createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><body>
      <h1>联系人列表</h1>
      <input id="search" />
      <div id="member">陈佳行 管理员</div>
      <script>
        document.getElementById("search").addEventListener("input", (event) => {
          if (event.target.value) document.getElementById("member")?.remove();
        });
      </script>
    </body>`);
  });
}

function ir(baseUrl: string, assertions: TestIR["assertions"]): TestIR {
  return {
    id: "not-contains",
    version: 1,
    platform: "web",
    baseUrl,
    steps: [{ id: "open", action: "navigate", path: "/" }],
    assertions,
    policy: { screenshots: "never" },
  };
}

test("ui assertion requires text to be present and absent together", async () => {
  const srv = server();
  const port = await listen(srv);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const pass = await runTestIR(
      ir(baseUrl, [
        { id: "both", type: "ui", contains: "联系人列表", notContains: "未找到", oracle: "human-approved" },
      ]),
      { env: { baseUrl }, headless: true, artifactsDir: await mkdtemp(join(tmpdir(), "tp-ui-a-")) },
    );
    assert.equal(pass.status, "passed");

    const fail = await runTestIR(
      ir(baseUrl, [
        { id: "leak", type: "ui", contains: "联系人列表", notContains: "陈佳行", oracle: "human-approved" },
      ]),
      { env: { baseUrl }, headless: true, artifactsDir: await mkdtemp(join(tmpdir(), "tp-ui-b-")) },
    );
    assert.equal(fail.status, "failed");
    assert.match(fail.assertions[0]?.message ?? "", /still contains/);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test("ui assertion target resolves by visible text name", async () => {
  const srv = server();
  const port = await listen(srv);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(
      ir(baseUrl, [{ id: "member", type: "ui", target: { name: "陈佳行" }, oracle: "human-approved" }]),
      { env: { baseUrl }, headless: true, artifactsDir: await mkdtemp(join(tmpdir(), "tp-ui-name-")) },
    );
    assert.equal(run.status, "passed", JSON.stringify(run.assertions));
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test("ui assertion can wait for text to disappear after a filter", async () => {
  const srv = server();
  const port = await listen(srv);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(
      {
        ...ir(baseUrl, [
          { id: "gone", type: "ui", contains: "联系人列表", notContains: "陈佳行", oracle: "human-approved" },
        ]),
        steps: [
          { id: "open", action: "navigate", path: "/" },
          { id: "hide", action: "fill", target: { css: "#search" }, value: "zzz" },
        ],
      },
      { env: { baseUrl }, headless: true, artifactsDir: await mkdtemp(join(tmpdir(), "tp-ui-c-")) },
    );
    assert.equal(run.status, "passed", JSON.stringify(run.assertions));
    assert.equal(run.assertions[0]?.passed, true);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test("assertion targets render {{runId}} so a run-unique marker can be asserted", async () => {
  const srv = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><body>
      <h1>模板夹具</h1>
      <input id="marker" />
      <div id="echo"></div>
      <script>
        document.getElementById("marker").addEventListener("input", (event) => {
          document.getElementById("echo").textContent = event.target.value;
        });
      </script>
    </body>`);
  });
  const port = await listen(srv);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(
      {
        ...ir(baseUrl, [{ id: "echo", type: "ui", target: { name: "M-{{runId}}" }, oracle: "human-approved" }]),
        steps: [
          { id: "open", action: "navigate", path: "/" },
          { id: "type", action: "fill", target: { css: "#marker" }, value: "M-{{runId}}" },
        ],
      },
      { env: { baseUrl }, headless: true, artifactsDir: await mkdtemp(join(tmpdir(), "tp-ui-runid-")) },
    );
    assert.equal(run.status, "passed", JSON.stringify(run.assertions));
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

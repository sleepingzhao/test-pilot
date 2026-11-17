import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
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

function createActorServer(): Server {
  return createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (url.pathname === "/login") {
      const as = url.searchParams.get("as") ?? "a";
      res.writeHead(302, {
        "set-cookie": `actor=${as}; Path=/; HttpOnly`,
        location: "/",
      });
      res.end();
      return;
    }
    if (url.pathname === "/whoami") {
      const cookie = req.headers.cookie ?? "";
      const match = /(?:^|;\s*)actor=([^;]+)/.exec(cookie);
      const actor = match?.[1] ?? "none";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ actor }));
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html><body>
<p id="primary-only" data-testid="primary-only">only-on-primary</p>
<button type="button" data-testid="tag-a" onclick="fetch('/whoami').then(r=>r.json()).then(j=>{document.getElementById('out').textContent=j.actor})">tag a</button>
<button type="button" data-testid="tag-b" onclick="fetch('/whoami').then(r=>r.json()).then(j=>{document.getElementById('out-b').textContent=j.actor})">tag b</button>
<span id="out" data-testid="who-a"></span>
<span id="out-b" data-testid="who-b"></span>
</body></html>`);
      return;
    }
  });
}

function twoActorIr(baseUrl: string): TestIR {
  return {
    id: "multi-actor-demo",
    version: 1,
    platform: "web",
    baseUrl,
    actors: [
      {
        id: "a",
        loginSteps: [{ id: "login-a", action: "navigate", path: "/login?as=a" }],
      },
      {
        id: "b",
        loginSteps: [{ id: "login-b", action: "navigate", path: "/login?as=b" }],
      },
    ],
    steps: [
      { id: "open-a", action: "navigate", path: "/", actor: "a" },
      { id: "click-a", action: "click", target: { testId: "tag-a" }, actor: "a" },
      { id: "wait-a", action: "wait", target: { testId: "who-a" }, actor: "a" },
      {
        id: "req-a",
        action: "request",
        method: "GET",
        path: "/whoami",
        actor: "a",
        saveFields: { actorA: "actor" },
      },
      { id: "open-b", action: "navigate", path: "/", actor: "b" },
      { id: "click-b", action: "click", target: { testId: "tag-b" }, actor: "b" },
      {
        id: "req-b",
        action: "request",
        method: "GET",
        path: "/whoami",
        actor: "b",
        saveFields: { actorB: "actor" },
      },
    ],
    assertions: [
      {
        id: "ui-a",
        type: "ui",
        oracle: "human-approved",
        target: { testId: "who-a" },
        contains: "a",
        actor: "a",
      },
      {
        id: "ui-b-only",
        type: "ui",
        oracle: "human-approved",
        target: { testId: "who-b" },
        contains: "b",
        actor: "b",
      },
      {
        id: "api-a",
        type: "api",
        oracle: "api-contract",
        stepRef: "req-a",
        actor: "a",
        expect: { statusCode: 200, responseBodyContains: '"actor":"a"' },
      },
    ],
  };
}

test("two actors: isolated cookies, UI/API assertions, multi actorMode", async () => {
  const server = createActorServer();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const artifactsDir = join(process.cwd(), "artifacts-multi-actor-ok");
  try {
    const run = await runTestIR(twoActorIr(baseUrl), {
      headless: true,
      artifactsDir,
      env: { baseUrl, baseUrlRefs: { "staging-console": baseUrl } },
    });
    assert.equal(run.status, "passed");
    assert.equal(run.actorMode, "multi");
    const runDir = join(artifactsDir, run.runId);
    const actorDir = join(runDir, "actors", "b");
    assert.ok(existsSync(join(actorDir, "network.json")));
    assert.ok(existsSync(join(actorDir, "trace.zip")));
    assert.ok(existsSync(join(runDir, "network.json")));
    assert.ok(existsSync(join(runDir, "trace.zip")));
  } finally {
    server.close();
  }
});

test("no actors: actorMode single and primary artifacts only", async () => {
  const server = createActorServer();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const ir: TestIR = {
    id: "single-fallback",
    version: 1,
    platform: "web",
    baseUrl,
    steps: [
      { id: "login", action: "navigate", path: "/login?as=a" },
      { id: "open", action: "navigate", path: "/" },
    ],
    assertions: [{ type: "ui", oracle: "human-approved", contains: "only-on-primary" }],
  };
  const run = await runTestIR(ir, { headless: true, env: { baseUrl } });
  assert.equal(run.actorMode, "single");
  assert.equal(run.status, "passed");
  server.close();
});

test("unknown assertion actor fails without validation", async () => {
  const server = createActorServer();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const ir = twoActorIr(baseUrl);
  ir.assertions.push({
    id: "bad-actor",
    type: "ui",
    oracle: "human-approved",
    contains: "x",
    actor: "ghost",
  });
  const run = await runTestIR(ir, { headless: true, env: { baseUrl } });
  assert.equal(run.status, "failed");
  const failed = run.assertions.find((a) => a.assertionId === "bad-actor");
  assert.match(failed?.message ?? "", /unknown actor: ghost/);
  server.close();
});

test("login failure prefixes [actor:id] and cleanup always still runs", async () => {
  const server = createActorServer();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const ir: TestIR = {
    id: "login-fail",
    version: 1,
    platform: "web",
    baseUrl,
    policy: { cleanup: "always" },
    actors: [
      {
        id: "a",
        loginSteps: [{ id: "login-a", action: "navigate", path: "/login?as=a" }],
      },
      {
        id: "b",
        loginSteps: [{ id: "login-b", action: "click", target: { testId: "missing-on-login" } }],
      },
    ],
    steps: [{ id: "noop", action: "wait" }],
    teardownSteps: [{ id: "td", action: "request", method: "GET", path: "/whoami" }],
    assertions: [{ type: "ui", oracle: "human-approved", contains: "only-on-primary" }],
  };
  const run = await runTestIR(ir, { headless: true, env: { baseUrl } });
  assert.equal(run.status, "failed");
  assert.match(run.steps[0]?.message ?? "", /^\[actor:b\]/);
  assert.ok(run.cleanup);
  assert.notEqual(run.cleanup?.status, "skipped");
  server.close();
});

test("assertion on actor B uses B page (primary-only element absent on B after navigate)", async () => {
  const server = createActorServer();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const ir: TestIR = {
    id: "actor-b-ui",
    version: 1,
    platform: "web",
    baseUrl,
    actors: [
      { id: "a", loginSteps: [{ id: "la", action: "navigate", path: "/login?as=a" }] },
      { id: "b", loginSteps: [{ id: "lb", action: "navigate", path: "/login?as=b" }] },
    ],
    steps: [
      { id: "hit-b", action: "navigate", path: "/whoami", actor: "b" },
      { id: "back", action: "navigate", path: "/", actor: "b" },
      { id: "tap", action: "click", target: { testId: "tag-b" }, actor: "b" },
      { id: "w", action: "wait", target: { testId: "who-b" }, actor: "b" },
    ],
    assertions: [
      {
        id: "primary-miss-on-b",
        type: "ui",
        oracle: "human-approved",
        target: { testId: "primary-only" },
        contains: "only-on-primary",
        actor: "b",
      },
    ],
  };
  const run = await runTestIR(ir, { headless: true, env: { baseUrl } });
  assert.equal(run.status, "passed");
  assert.equal(run.actorMode, "multi");
  server.close();
});
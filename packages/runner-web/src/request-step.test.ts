import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { TestIR, TestStep } from "@testpilot/test-ir";
import { waitForHttpReady } from "@testpilot/fixtures";
import { resolveSameOriginRequestUrl, runTestIR } from "./run.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const demoDir = join(root, "examples/demo-webapp");

function requestIr(baseUrl: string, steps: TestStep[]): TestIR {
  return {
    id: "request-step",
    version: 1,
    platform: "web",
    baseUrl,
    steps,
    assertions: [],
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

test("resolveSameOriginRequestUrl allows the base origin and rejects SSRF targets", () => {
  const base = "http://127.0.0.1:4187";
  assert.equal(resolveSameOriginRequestUrl("/api/users", base).href, "http://127.0.0.1:4187/api/users");
  assert.equal(
    resolveSameOriginRequestUrl("http://127.0.0.1:4187/api/users", base).href,
    "http://127.0.0.1:4187/api/users",
  );
  assert.throws(() => resolveSameOriginRequestUrl(undefined, base), /requires path/);
  assert.throws(() => resolveSameOriginRequestUrl("http://127.0.0.1:1/api/users", base), /cross-origin/);
  assert.throws(() => resolveSameOriginRequestUrl("https://evil.example/api/users", base), /cross-origin/);
  assert.throws(() => resolveSameOriginRequestUrl("file:///etc/passwd", base), /http/);
  assert.throws(() => resolveSameOriginRequestUrl("//evil.example/api", base), /protocol-relative/);
  assert.throws(
    () => resolveSameOriginRequestUrl("http://user:secret@127.0.0.1:4187/api/users", base),
    /credential/,
  );
});

test("request step POSTs /api/users on the demo app", async () => {
  const port = 4187;
  const baseUrl = `http://127.0.0.1:${port}`;
  const email = `v7-${Date.now()}@example.com`;
  const demo: ChildProcess = spawn("node", ["server.mjs"], {
    cwd: demoDir,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  try {
    await waitForHttpReady(`${baseUrl}/`);
    const run = await runTestIR(
      requestIr(baseUrl, [
        { id: "open", action: "navigate", path: "/" },
        {
          id: "create-user",
          action: "request",
          method: "POST",
          path: "/api/users",
          body: { email },
        },
      ]),
      { env: { baseUrl }, headless: true },
    );
    assert.equal(run.status, "passed", run.steps.map((step) => step.message).join("; "));
    assert.equal(run.steps.find((step) => step.stepId === "create-user")?.status, "passed");

    const again = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    assert.equal(again.status, 409);
  } finally {
    demo.kill("SIGTERM");
  }
});

test("request step sends the browser context cookie", async () => {
  let cookie: string | undefined;
  const server = createServer((req, res) => {
    if (req.url === "/api/session") {
      cookie = req.headers.cookie;
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><body>login<script>document.cookie='session=abc; Path=/';</script></body>");
  });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(
      requestIr(baseUrl, [
        { id: "open", action: "navigate", path: "/" },
        { id: "whoami", action: "request", method: "GET", path: "/api/session" },
      ]),
      { env: { baseUrl }, headless: true },
    );
    assert.equal(run.status, "passed", run.steps.map((step) => step.message).join("; "));
    assert.match(cookie ?? "", /session=abc/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("request step fails on a cross-origin URL before any fetch", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><body>ok</body>");
  });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(
      requestIr(baseUrl, [
        { id: "open", action: "navigate", path: "/" },
        { id: "steal", action: "request", method: "GET", path: "http://127.0.0.1:1/api/users" },
      ]),
      { env: { baseUrl }, headless: true },
    );
    const step = run.steps.find((item) => item.stepId === "steal");
    assert.equal(run.status, "failed");
    assert.equal(step?.status, "failed");
    assert.match(step?.message ?? "", /cross-origin/);
    assert.equal(hits, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("request step does not follow a redirect to another origin", async () => {
  let evilHits = 0;
  const evil = createServer((_req, res) => {
    evilHits += 1;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("nope");
  });
  const evilPort = await listen(evil);
  const server = createServer((req, res) => {
    if (req.url === "/api/hop") {
      res.writeHead(302, { location: `http://127.0.0.1:${evilPort}/steal` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><body>ok</body>");
  });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(
      requestIr(baseUrl, [
        { id: "open", action: "navigate", path: "/" },
        { id: "hop", action: "request", method: "GET", path: "/api/hop" },
      ]),
      { env: { baseUrl }, headless: true },
    );
    const step = run.steps.find((item) => item.stepId === "hop");
    assert.equal(step?.status, "passed", step?.message);
    assert.equal(evilHits, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => evil.close(() => resolve()));
  }
});

test("request step fails when method or path is missing", async () => {
  const baseUrl = "http://127.0.0.1:9";
  const missingMethod = await runTestIR(
    requestIr(baseUrl, [{ id: "call", action: "request", path: "/api/users" }]),
    { env: { baseUrl }, headless: true },
  );
  assert.equal(missingMethod.steps[0]?.status, "failed");
  assert.match(missingMethod.steps[0]?.message ?? "", /requires method/);

  const missingPath = await runTestIR(
    requestIr(baseUrl, [{ id: "call", action: "request", method: "GET" }]),
    { env: { baseUrl }, headless: true },
  );
  assert.equal(missingPath.steps[0]?.status, "failed");
  assert.match(missingPath.steps[0]?.message ?? "", /requires path/);
});

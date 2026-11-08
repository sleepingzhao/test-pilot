import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function filesContain(dir: string, needle: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true });
  const raw = Buffer.from(needle);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await filesContain(path, needle)) return true;
      continue;
    }
    const buf = await readFile(path);
    if (buf.includes(raw)) return true;
  }
  return false;
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

test("request step saves an id and uses it on the next call", async () => {
  const users = new Map<string, { email: string }>();
  let echo = "";
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === "POST" && req.url === "/api/users") {
        const body = JSON.parse(await readBody(req)) as { email: string };
        const id = "user-1";
        users.set(id, { email: body.email });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id, email: body.email }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/api/users/")) {
        const id = req.url.slice("/api/users/".length);
        const user = users.get(id);
        res.writeHead(user ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(user ?? { error: "missing" }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/echo") {
        echo = await readBody(req);
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><body>ok</body>");
    })();
  });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(
      requestIr(baseUrl, [
        {
          id: "create",
          action: "request",
          method: "POST",
          path: "/api/users",
          body: { email: "created-{{runId}}@example.com" },
          saveAs: "raw",
          saveFields: { userId: "id" },
        },
        { id: "load", action: "request", method: "GET", path: "/api/users/{{userId}}" },
        { id: "echo", action: "request", method: "POST", path: "/api/echo", body: "{{raw}}" },
      ]),
      { env: { baseUrl }, headless: true, runId: "run-template" },
    );
    assert.equal(run.status, "passed", run.steps.map((step) => step.message).join("; "));
    assert.equal(users.get("user-1")?.email, "created-run-template@example.com");
    assert.match(echo, /"id":"user-1"/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("request step fails when an env template is missing and does not record the secret", async () => {
  const token = "sekret-v7-token-value";
  const envName = "TESTPILOT_ENV_V7TOKEN";
  const previous = process.env[envName];
  delete process.env.TESTPILOT_ENV_V7MISSING;
  process.env[envName] = token;
  let hits = 0;
  let seenToken = "";
  const server = createServer((req, res) => {
    hits += 1;
    seenToken = String(req.headers["x-test-token"] ?? "");
    res.writeHead(204);
    res.end();
  });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const artifactsDir = await mkdtemp(join(tmpdir(), "testpilot-request-env-"));
  try {
    const missing = await runTestIR(
      requestIr(baseUrl, [
        {
          id: "call",
          action: "request",
          method: "GET",
          path: "/api/secret",
          headers: { "x-test-token": "{{env.v7Missing}}" },
        },
      ]),
      { env: { baseUrl }, headless: true, artifactsDir },
    );
    assert.equal(missing.steps[0]?.status, "failed");
    assert.match(missing.steps[0]?.message ?? "", /request missing env: v7Missing \(TESTPILOT_ENV_V7MISSING\)/);
    assert.equal(hits, 0);

    const missingVar = await runTestIR(
      requestIr(baseUrl, [
        { id: "call", action: "request", method: "GET", path: "/api/users/{{userId}}" },
      ]),
      { env: { baseUrl }, headless: true, artifactsDir },
    );
    assert.equal(missingVar.steps[0]?.status, "failed");
    assert.match(missingVar.steps[0]?.message ?? "", /request missing variable: userId/);
    assert.equal(hits, 0);

    const sent = await runTestIR(
      requestIr(baseUrl, [
        {
          id: "call",
          action: "request",
          method: "GET",
          path: "/api/secret",
          headers: { "x-test-token": "{{env.v7Token}}" },
        },
      ]),
      { env: { baseUrl }, headless: true, artifactsDir, runId: "env-sent" },
    );
    assert.equal(sent.status, "passed", sent.steps.map((step) => step.message).join("; "));
    assert.equal(seenToken, token);
    assert.equal(JSON.stringify(sent).includes(token), false);
    assert.equal(await filesContain(join(artifactsDir, "env-sent"), token), false);
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("api assertion matches a request step response of 201 and JSON", async () => {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/users") {
      void readBody(req).then(() => {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, email: "created@example.com" }));
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><body>ok</body>");
  });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const artifactsDir = await mkdtemp(join(tmpdir(), "testpilot-request-evidence-"));
  try {
    const run = await runTestIR(
      {
        id: "request-assert",
        version: 1,
        platform: "web",
        baseUrl,
        steps: [
          { id: "open", action: "navigate", path: "/" },
          {
            id: "create",
            action: "request",
            method: "POST",
            path: "/api/users",
            headers: { authorization: "Bearer sekret-v7-evidence", cookie: "session=abc" },
            body: { email: "created@example.com" },
          },
        ],
        assertions: [
          {
            id: "created",
            type: "api",
            requestRef: "users-create",
            expect: { statusCode: 201, responseJsonBody: { ok: true, email: "created@example.com" } },
            oracle: "api-contract",
          },
        ],
      },
      {
        env: {
          baseUrl,
          requestRefs: { "users-create": { urlIncludes: "/api/users", method: "POST" } },
        },
        headless: true,
        artifactsDir,
        runId: "evidence-run",
      },
    );
    assert.equal(run.status, "passed", run.assertions.map((item) => item.message).join("; "));
    assert.equal(run.assertions[0]?.passed, true);
    assert.ok(run.artifacts.artifacts.some((item) => item.kind === "network"));
    const written = await readFile(join(artifactsDir, "evidence-run", "network.json"), "utf8");
    assert.match(written, /"authorization": "\*\*\*"/);
    assert.match(written, /"cookie": "\*\*\*"/);
    assert.doesNotMatch(written, /sekret-v7-evidence/);
    assert.doesNotMatch(written, /session=abc/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

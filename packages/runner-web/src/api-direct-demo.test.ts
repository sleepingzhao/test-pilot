import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { TestIR } from "@testpilot/test-ir";
import { resolveRequestRef, waitForHttpReady, type RunEnvironment } from "@testpilot/fixtures";
import { runTestIR, type RunResult } from "./run.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const demoDir = join(root, "examples/demo-webapp");

/** Demo API cases resolve this name only through the run environment. */
const API_USERS_CREATE = { urlIncludes: "/api/users", method: "POST" };

function demoEnv(baseUrl: string): RunEnvironment {
  return { baseUrl };
}

async function loadIr(name: string): Promise<TestIR> {
  const raw = await readFile(join(root, "examples/demo-webapp/tests", name), "utf8");
  return JSON.parse(raw) as TestIR;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

async function startDemo(): Promise<{ baseUrl: string; stop: () => void }> {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const demo: ChildProcess = spawn("node", ["server.mjs"], {
    cwd: demoDir,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  await waitForHttpReady(`${baseUrl}/practice-login.html`);
  return {
    baseUrl,
    stop: () => demo.kill("SIGTERM"),
  };
}

function faultServer(status: number, body: unknown): Server {
  return createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/users") {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>练习登录</title><body>login</body>");
  });
}

test("requestRef still resolves through env.requestRefs for UI-triggered calls", () => {
  const base = { baseUrl: "http://127.0.0.1:4173" };
  assert.deepEqual(resolveRequestRef("api-users-create", base), API_USERS_CREATE);
  const env: RunEnvironment = {
    ...base,
    requestRefs: { "api-users-injected": API_USERS_CREATE },
  };
  assert.deepEqual(resolveRequestRef("api-users-injected", env), API_USERS_CREATE);
  assert.equal(resolveRequestRef("api-users-missing", env), undefined);
});

test("demo login then POST /api/users asserts 201, 409, and 400", async () => {
  const demo = await startDemo();
  try {
    const created = await runTestIR(await loadIr("api-user-create.json"), {
      env: demoEnv(demo.baseUrl),
      headless: true,
      runId: "api-create",
    });
    assert.equal(created.status, "passed", created.assertions.map((item) => item.message).join("; "));
    assert.equal(created.assertions[0]?.passed, true);
    assert.equal(created.assertions[0]?.assertionId, "created");
    assert.ok(created.artifacts.artifacts.some((item) => item.kind === "network"));

    const duplicate = await runTestIR(await loadIr("api-duplicate-email.json"), {
      env: demoEnv(demo.baseUrl),
      headless: true,
      runId: "api-duplicate",
    });
    assert.equal(duplicate.status, "passed", duplicate.assertions.map((item) => item.message).join("; "));
    assert.equal(duplicate.assertions[0]?.assertionId, "duplicate");

    const missing = await runTestIR(await loadIr("api-missing-email.json"), {
      env: demoEnv(demo.baseUrl),
      headless: true,
      runId: "api-missing",
    });
    assert.equal(missing.status, "passed", missing.assertions.map((item) => item.message).join("; "));
    assert.equal(missing.assertions[0]?.assertionId, "missing-email");
  } finally {
    demo.stop();
  }
});

test("api assertion fails when the server returns 500 or the wrong JSON", async () => {
  const faultIr = await loadIr("api-user-create.json");
  const envFor = (baseUrl: string): RunEnvironment => ({ baseUrl });

  const server500 = faultServer(500, { error: "injected" });
  const port500 = await listen(server500);
  try {
    const failed = await runTestIR(faultIr, {
      env: envFor(`http://127.0.0.1:${port500}`),
      headless: true,
      runId: "fault-500",
    });
    assertProductDefect(failed, /status 201/);
    assert.equal(failed.steps.every((step) => step.status === "passed"), true);
  } finally {
    await new Promise<void>((resolve) => server500.close(() => resolve()));
  }

  const serverJson = faultServer(201, { error: "injected" });
  const portJson = await listen(serverJson);
  try {
    const failed = await runTestIR(faultIr, {
      env: envFor(`http://127.0.0.1:${portJson}`),
      headless: true,
      runId: "fault-json",
    });
    assertProductDefect(failed, /response JSON body did not match|response body does not contain/);
    assert.equal(failed.steps.every((step) => step.status === "passed"), true);
  } finally {
    await new Promise<void>((resolve) => serverJson.close(() => resolve()));
  }
});

function assertProductDefect(run: RunResult, message: RegExp) {
  assert.equal(run.status, "failed");
  const assertion = run.assertions[0];
  assert.equal(assertion?.passed, false);
  assert.equal(assertion?.errorKind, "PRODUCT_DEFECT");
  assert.equal(assertion?.assertionId, "created");
  assert.match(assertion?.message ?? "", message);
}

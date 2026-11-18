import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import test from "node:test";
import type { BrowserContext, Page } from "playwright";
import type { TestIR } from "@testpilot/test-ir";
import { runTestIR } from "./run.js";

const FAKE_PASSWORD = "TP-FAKE-LOGIN-SECRET-7f3a";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

function createLoginServer(): Server {
  return createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "/";
      if (url === "/login" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><body>
          <form method="POST" action="/login">
            <input name="tenantCode" />
            <input name="userCode" />
            <input name="password" type="password" />
            <button type="submit">登录</button>
          </form>
        </body>`);
        return;
      }
      if (url === "/login" && req.method === "POST") {
        await readBody(req);
        res.writeHead(302, {
          location: "/app",
          "set-cookie": "session=fake; Path=/; HttpOnly",
        });
        res.end();
        return;
      }
      if (url === "/app") {
        const cookie = req.headers.cookie ?? "";
        if (!cookie.includes("session=fake")) {
          res.writeHead(302, { location: "/login" });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><body><h1>登录成功</h1><button>继续</button></body>");
        return;
      }
      if (url === "/api/ping" && req.method === "DELETE") {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><body>home</body>");
    })();
  });
}

async function fakeRealLogin(page: Page, _context: BrowserContext, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="password"]').fill(FAKE_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => u.pathname === "/app", { timeout: 10_000 });
}

function appIr(baseUrl: string, overrides: Partial<TestIR> = {}): TestIR {
  return {
    id: "real-login-hook",
    version: 1,
    platform: "web",
    baseUrl,
    steps: [{ id: "open-app", action: "navigate", path: "/app" }],
    assertions: [
      { id: "logged-in", type: "ui", contains: "登录成功", oracle: "human-approved" },
    ],
    ...overrides,
  };
}

function cleanupIr(baseUrl: string): TestIR {
  return {
    ...appIr(baseUrl, { policy: { cleanup: "always" } }),
    steps: [
      { id: "open-app", action: "navigate", path: "/app" },
      {
        id: "noop",
        action: "request",
        method: "GET",
        path: "/",
      },
    ],
    teardownSteps: [
      {
        id: "teardown-ping",
        action: "request",
        method: "DELETE",
        path: "/api/ping",
      },
    ],
  };
}

test("login hook runs before steps and UI assertion passes", async () => {
  const server = createLoginServer();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(appIr(baseUrl), {
      env: { baseUrl },
      headless: true,
      login: fakeRealLogin,
    });
    assert.equal(run.status, "passed");
    assert.equal(run.actorMode, "single");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("without login hook steps behave as before on an open page", async () => {
  const server = createLoginServer();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(
      {
        id: "no-hook",
        version: 1,
        platform: "web",
        baseUrl,
        steps: [{ id: "home", action: "navigate", path: "/" }],
        assertions: [{ id: "home", type: "ui", contains: "home", oracle: "human-approved" }],
      },
      { env: { baseUrl }, headless: true },
    );
    assert.equal(run.status, "passed");
    assert.equal(run.actorMode, "single");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("login hook failure fails run without steps and still runs always cleanup", async () => {
  const server = createLoginServer();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(cleanupIr(baseUrl), {
      env: { baseUrl },
      headless: true,
      login: async (page, _context, baseUrl) => {
        await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
        await page.locator('input[name="password"]').fill(FAKE_PASSWORD);
        throw new Error("enterprise SSO unavailable");
      },
    });
    assert.equal(run.status, "failed");
    assert.equal(run.steps.length, 0);
    assert.match(run.artifacts.notes ?? "", /^真实环境登录失败:/);
    assert.equal(run.metrics.failureKind, "ENVIRONMENT");
    assert.equal(run.cleanup?.status, "passed");
    assert.ok(!JSON.stringify(run).includes(FAKE_PASSWORD));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("login hook credentials are absent from run result JSON", async () => {
  const server = createLoginServer();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(appIr(baseUrl), {
      env: { baseUrl },
      headless: true,
      login: fakeRealLogin,
    });
    assert.ok(!JSON.stringify(run).includes(FAKE_PASSWORD));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("multi-actor real login runs per actor with its configured account", async () => {
  const server = createLoginServer();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const accounts: string[] = [];
  try {
    const run = await runTestIR(
      {
        id: "real-login-multi",
        version: 1,
        platform: "web",
        baseUrl,
        actors: [{ id: "primary" }, { id: "alt-actor", account: "alt" }],
        steps: [
          { id: "open-primary", action: "navigate", path: "/app" },
          { id: "open-alt", action: "navigate", path: "/app", actor: "alt-actor" },
        ],
        assertions: [
          { id: "primary-ok", type: "ui", contains: "登录成功", oracle: "human-approved" },
          { id: "alt-ok", type: "ui", contains: "登录成功", oracle: "human-approved", actor: "alt-actor" },
        ],
      },
      {
        env: { baseUrl },
        headless: true,
        login: async (page, context, url, account) => {
          accounts.push(account ?? "primary");
          await fakeRealLogin(page, context, url);
        },
      },
    );
    assert.equal(run.status, "passed", run.artifacts.notes);
    assert.deepEqual(accounts, ["primary", "alt"]);
    assert.equal(run.actorMode, "multi");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("multi-actor real login failure names the actor and stops before steps", async () => {
  const server = createLoginServer();
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(
      {
        id: "real-login-multi-fail",
        version: 1,
        platform: "web",
        baseUrl,
        actors: [{ id: "primary" }, { id: "alt-actor", account: "alt" }],
        steps: [{ id: "open-primary", action: "navigate", path: "/app" }],
        assertions: [{ id: "primary-ok", type: "ui", contains: "登录成功", oracle: "human-approved" }],
      },
      {
        env: { baseUrl },
        headless: true,
        login: async (page, context, url, account) => {
          if (account === "alt") throw new Error("second account unavailable");
          await fakeRealLogin(page, context, url);
        },
      },
    );
    assert.equal(run.status, "failed");
    assert.equal(run.steps.length, 0);
    assert.match(run.artifacts.notes ?? "", /真实环境登录失败（alt-actor）: second account unavailable/);
    assert.equal(run.metrics.failureKind, "ENVIRONMENT");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

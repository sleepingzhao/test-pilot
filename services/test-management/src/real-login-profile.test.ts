import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { loginRealPage } from "./real-login.js";
import { realLoginProfileFromEnv } from "./real-login-profile.js";

const ENV_KEYS = [
  "TESTPILOT_REAL_LOGIN_PROFILE_JSON",
  "TESTPILOT_ENV_REAL_ENTERPRISE_ID",
  "TESTPILOT_ENV_REAL_USER_ID",
  "TESTPILOT_ENV_REAL_PASSWORD",
] as const;

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[key] = value;
  }
  return fn().finally(() => {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("login profile parses the JSON adapter and rejects invalid shapes", () => {
  withEnv({ TESTPILOT_REAL_LOGIN_PROFILE_JSON: '{"submitText":"Sign in","passwordField":"#pw"}' }, async () => {
    assert.deepEqual(realLoginProfileFromEnv(), { submitText: "Sign in", passwordField: "#pw" });
  });
  withEnv({ TESTPILOT_REAL_LOGIN_PROFILE_JSON: "not-json" }, async () => {
    assert.throws(() => realLoginProfileFromEnv(), /JSON/);
  });
  withEnv({ TESTPILOT_REAL_LOGIN_PROFILE_JSON: '{"tenantField":5}' }, async () => {
    assert.throws(() => realLoginProfileFromEnv(), /tenantField/);
  });
});

async function loginServer(fields: "generic" | "configured") {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      if ((req.url ?? "/") === "/login" && req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        seen.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(302, { location: "/app", "set-cookie": "session=ok; Path=/" });
        res.end();
        return;
      }
      if ((req.url ?? "/") === "/app") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<h1>登录成功</h1>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        fields === "generic"
          ? '<form method="POST" action="/login"><input type="text" name="account" /><input type="password" name="password" /><button type="submit">登录</button></form>'
          : '<form method="POST" action="/login"><input name="tenantCode" /><input name="userCode" /><input type="password" name="password" /><button type="submit">登录</button></form>',
      );
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return { server, baseUrl: `http://127.0.0.1:${port}`, seen };
}

test("generic login works without a site-specific profile", async () => {
  const { server, baseUrl, seen } = await loginServer("generic");
  const browser = await chromium.launch({ headless: true });
  try {
    await withEnv(
      {
        TESTPILOT_ENV_REAL_ENTERPRISE_ID: "ACME",
        TESTPILOT_ENV_REAL_USER_ID: "user01",
        TESTPILOT_ENV_REAL_PASSWORD: "secret",
      },
      async () => {
        const page = await browser.newPage();
        await loginRealPage(page, baseUrl);
        assert.match(page.url(), /\/app$/);
      },
    );
    assert.equal(seen.length, 1);
    assert.match(seen[0]!, /user01/);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("configured login profile fills tenant and user fields", async () => {
  const { server, baseUrl, seen } = await loginServer("configured");
  const browser = await chromium.launch({ headless: true });
  try {
    await withEnv(
      {
        TESTPILOT_ENV_REAL_ENTERPRISE_ID: "ACME",
        TESTPILOT_ENV_REAL_USER_ID: "user01",
        TESTPILOT_ENV_REAL_PASSWORD: "secret",
        TESTPILOT_REAL_LOGIN_PROFILE_JSON: JSON.stringify({
          tenantField: 'input[name="tenantCode"]',
          userField: 'input[name="userCode"]',
          passwordField: 'input[name="password"]',
          submitText: "登录",
        }),
      },
      async () => {
        const page = await browser.newPage();
        await loginRealPage(page, baseUrl);
        assert.match(page.url(), /\/app$/);
      },
    );
    assert.match(seen[0] ?? "", /tenantCode=ACME/);
    assert.match(seen[0] ?? "", /userCode=user01/);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

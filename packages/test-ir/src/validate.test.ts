import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { validateSemantics, validateTestIR, weakAssertionIssues } from "./validate.js";
import type { TestIR } from "./types.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

test("accepts roadmap example IR", () => {
  const doc = JSON.parse(readFileSync(join(fixturesDir, "user-create-duplicate-email.json"), "utf8"));
  const result = validateTestIR(doc);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(validateSemantics(result.value), []);
  }
});

test("rejects step without required fields", () => {
  const result = validateTestIR({
    id: "bad",
    version: 1,
    platform: "web",
    steps: [{ id: "x", action: "click" }],
    assertions: [{ type: "ui", oracle: "human-approved", contains: "ok" }],
  });
  assert.equal(result.ok, false);
});

test("accepts a per-test baseUrl", () => {
  const result = validateTestIR({
    id: "pinned",
    version: 1,
    platform: "web",
    baseUrl: "https://staging.example.com",
    steps: [{ id: "open", action: "navigate", path: "/" }],
    assertions: [{ type: "ui", oracle: "human-approved", contains: "ok" }],
  });
  assert.equal(result.ok, true);
});

test("accepts assertion provider and configRef", () => {
  const result = validateTestIR({
    id: "ext",
    version: 1,
    platform: "web",
    steps: [{ id: "open", action: "navigate", path: "/" }],
    assertions: [
      {
        id: "db-check",
        type: "db",
        provider: "postgres-readonly",
        configRef: "pilot-db",
        oracle: "human-approved",
        expect: { queryRef: "order-by-run-id" },
      },
    ],
  });
  assert.equal(result.ok, true);
});

test("accepts selectCascader step", () => {
  const result = validateTestIR({
    id: "casc",
    version: 1,
    platform: "web",
    steps: [
      {
        id: "pick",
        action: "selectCascader",
        target: { testId: "region-cascader" },
        cascaderPath: ["广东省", "深圳市"],
      },
    ],
    assertions: [{ type: "ui", oracle: "human-approved", contains: "done ok" }],
  });
  assert.equal(result.ok, true);
});

test("accepts select step with value", () => {
  const result = validateTestIR({
    id: "select",
    version: 1,
    platform: "web",
    steps: [{ id: "pick", action: "select", target: { label: "优先级" }, value: "high" }],
    assertions: [{ type: "ui", oracle: "human-approved", contains: "done ok" }],
  });
  assert.equal(result.ok, true);
});

test("accepts a same-origin request step", () => {
  const result = validateTestIR({
    id: "api-create",
    version: 1,
    platform: "web",
    baseUrl: "http://127.0.0.1:4173",
    steps: [
      {
        id: "create-user",
        action: "request",
        method: "POST",
        path: "/api/users",
        headers: { "content-type": "application/json" },
        body: { email: "new@example.com" },
        saveAs: "created",
        saveFields: { userId: "id" },
      },
    ],
    assertions: [{ type: "ui", oracle: "human-approved", contains: "done ok" }],
  });
  assert.equal(result.ok, true, JSON.stringify(result.ok ? {} : result.issues));
  if (result.ok) assert.deepEqual(validateSemantics(result.value), []);
});

test("rejects a request step without method or path", () => {
  const missingMethod = validateTestIR({
    id: "api-create",
    version: 1,
    platform: "web",
    steps: [{ id: "create-user", action: "request", path: "/api/users" }],
    assertions: [{ type: "ui", oracle: "human-approved", contains: "done ok" }],
  });
  assert.equal(missingMethod.ok, false);
  if (!missingMethod.ok) {
    assert.ok(missingMethod.issues.some((issue) => issue.message.includes("method")));
  }

  const missingPath = validateTestIR({
    id: "api-create",
    version: 1,
    platform: "web",
    steps: [{ id: "create-user", action: "request", method: "GET" }],
    assertions: [{ type: "ui", oracle: "human-approved", contains: "done ok" }],
  });
  assert.equal(missingPath.ok, false);
  if (!missingPath.ok) {
    assert.ok(missingPath.issues.some((issue) => issue.message.includes("path")));
  }
});

test("rejects a request method outside the allow-list", () => {
  const result = validateTestIR({
    id: "api-create",
    version: 1,
    platform: "web",
    steps: [{ id: "create-user", action: "request", method: "OPTIONS", path: "/api/users" }],
    assertions: [{ type: "ui", oracle: "human-approved", contains: "done ok" }],
  });
  assert.equal(result.ok, false);
});

test("rejects a cross-origin absolute request path when baseUrl is set", () => {
  const result = validateTestIR({
    id: "api-create",
    version: 1,
    platform: "web",
    baseUrl: "http://127.0.0.1:4173",
    steps: [{ id: "steal", action: "request", method: "GET", path: "https://evil.example/api/users" }],
    assertions: [{ type: "ui", oracle: "human-approved", contains: "done ok" }],
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    const issues = validateSemantics(result.value);
    assert.equal(issues.length, 1);
    assert.match(issues[0]!.message, /same-origin/);
  }
});

test("flags short and generic page-wide UI assertions", () => {
  const base = {
    id: "weak",
    version: 1,
    platform: "web",
    steps: [{ id: "open", action: "navigate", path: "/" }],
  } as const;
  const weak = {
    ...base,
    assertions: [{ id: "a", type: "ui", contains: "工单", oracle: "human-approved" }],
  } as TestIR;
  assert.equal(weakAssertionIssues(weak).length, 1);

  const strong = {
    ...base,
    assertions: [{ id: "a", type: "ui", contains: "工单已提交", oracle: "human-approved" }],
  } as TestIR;
  assert.equal(weakAssertionIssues(strong).length, 0);

  const targeted = {
    ...base,
    assertions: [
      { id: "a", type: "ui", target: { testId: "ticket-alert" }, contains: "工单", oracle: "human-approved" },
    ],
  } as TestIR;
  assert.equal(weakAssertionIssues(targeted).length, 0);
});

test("stepRef binds an api assertion to a request step without requestRef", () => {
  const ir = {
    id: "step-ref",
    version: 1,
    platform: "web",
    baseUrl: "http://127.0.0.1:4173",
    steps: [{ id: "call", action: "request", method: "POST", path: "/api/users" }],
    assertions: [
      {
        id: "created",
        type: "api",
        provider: "captured-http",
        stepRef: "call",
        expect: { statusCode: 201 },
        oracle: "api-contract",
      },
    ],
  };
  const result = validateTestIR(ir);
  assert.equal(result.ok, true);
  assert.deepEqual(validateSemantics(ir as TestIR), []);
});

test("stepRef must point at an existing request step and cannot pair with requestRef (negative)", () => {
  const base = {
    id: "step-ref-bad",
    version: 1,
    platform: "web",
    steps: [{ id: "open", action: "navigate", path: "/" }],
  };
  const missing = {
    ...base,
    assertions: [
      {
        id: "a",
        type: "api",
        provider: "captured-http",
        stepRef: "call",
        expect: { statusCode: 200 },
        oracle: "api-contract",
      },
    ],
  } as TestIR;
  const issues = validateSemantics(missing);
  assert.ok(issues.some((issue) => /已有的 request 步骤/.test(issue.message)));

  const both = {
    ...base,
    steps: [{ id: "call", action: "request", method: "GET", path: "/api/x" }],
    assertions: [
      {
        id: "a",
        type: "api",
        provider: "captured-http",
        requestRef: "x",
        stepRef: "call",
        expect: { statusCode: 200 },
        oracle: "api-contract",
      },
    ],
  } as TestIR;
  assert.ok(validateSemantics(both).some((issue) => /二选一/.test(issue.message)));
});

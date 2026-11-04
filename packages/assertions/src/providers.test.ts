import assert from "node:assert/strict";
import test from "node:test";
import type { TestIR } from "@testpilot/test-ir";
import {
  getAssertionProvider,
  listAssertionProviders,
  resolveAssertionProviderId,
  runAssertion,
  validateAssertionProviders,
} from "./index.js";

const ctx = {
  page: {} as import("playwright").Page,
  network: [],
  resolveRequestRef: () => ({ urlIncludes: "/api/x", method: "POST" }),
};

test("built-in providers are registered", () => {
  const ids = listAssertionProviders().map((p) => p.id).sort();
  assert.deepEqual(ids, ["captured-http", "playwright-ui"]);
  assert.equal(getAssertionProvider("playwright-ui")?.kind, "ui");
  assert.equal(getAssertionProvider("captured-http")?.kind, "api");
});

test("resolveAssertionProviderId defaults ui and api", () => {
  assert.equal(resolveAssertionProviderId({ type: "ui", oracle: "human-approved" }), "playwright-ui");
  assert.equal(resolveAssertionProviderId({ type: "api", oracle: "human-approved", requestRef: "x" }), "captured-http");
});

test("resolveAssertionProviderId honors explicit provider", () => {
  assert.equal(
    resolveAssertionProviderId({ type: "ui", provider: "playwright-ui", oracle: "human-approved" }),
    "playwright-ui",
  );
});

test("db without provider fails at run time with ASSERTION_ORACLE", async () => {
  const outcome = await runAssertion({ type: "db", oracle: "human-approved" }, ctx);
  assert.equal(outcome.passed, false);
  assert.equal(outcome.errorKind, "ASSERTION_ORACLE");
  assert.match(outcome.message ?? "", /explicit provider/);
});

test("unknown provider fails at run time with ASSERTION_ORACLE", async () => {
  const outcome = await runAssertion(
    { type: "ui", provider: "no-such-provider", oracle: "human-approved" },
    ctx,
  );
  assert.equal(outcome.passed, false);
  assert.equal(outcome.errorKind, "ASSERTION_ORACLE");
  assert.match(outcome.message ?? "", /unknown assertion provider/);
});

test("validateAssertionProviders rejects missing and unknown providers", () => {
  const ir: TestIR = {
    id: "t",
    version: 1,
    platform: "web",
    steps: [{ id: "s", action: "navigate", path: "/" }],
    assertions: [
      { id: "db1", type: "db", oracle: "human-approved" },
      { id: "u1", type: "ui", provider: "missing", oracle: "human-approved" },
    ],
  };
  const issues = validateAssertionProviders(ir);
  assert.equal(issues.length, 2);
  assert.ok(issues.some((i) => i.message.includes("必须指定 provider")));
  assert.ok(issues.some((i) => i.message.includes("未知的断言 Provider")));
});

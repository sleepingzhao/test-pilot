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

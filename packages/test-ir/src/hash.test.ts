import assert from "node:assert/strict";
import { test } from "node:test";
import { computeIRHash } from "./hash.js";
import type { TestIR } from "./types.js";

function baseIR(): TestIR {
  return {
    id: "demo-hash",
    version: 1,
    platform: "web",
    steps: [
      { id: "open", action: "navigate", path: "/" },
      { id: "click", action: "click", target: { testId: "save" } },
    ],
    assertions: [{ id: "ok", type: "ui", contains: "saved", oracle: "human-approved" }],
  };
}

test("nested step changes alter the hash", () => {
  const a = baseIR();
  const b = baseIR();
  b.steps[1]!.target = { testId: "cancel" };
  assert.notEqual(computeIRHash(a), computeIRHash(b));
});

test("assertion changes alter the hash", () => {
  const a = baseIR();
  const b = baseIR();
  b.assertions[0]!.contains = "failed";
  assert.notEqual(computeIRHash(a), computeIRHash(b));
});

test("step order changes alter the hash", () => {
  const a = baseIR();
  const b = baseIR();
  b.steps = [b.steps[1]!, b.steps[0]!];
  assert.notEqual(computeIRHash(a), computeIRHash(b));
});

test("teardownSteps changes alter the hash", () => {
  const a = baseIR();
  const b = baseIR();
  b.teardownSteps = [{ id: "close", action: "request", method: "DELETE", path: "/api/x" }];
  b.policy = { cleanup: "always" };
  assert.notEqual(computeIRHash(a), computeIRHash(b));
});

test("policy.cleanup changes alter the hash", () => {
  const a = baseIR();
  const b = baseIR();
  a.teardownSteps = [{ id: "close", action: "request", method: "DELETE", path: "/api/x" }];
  a.policy = { cleanup: "always" };
  b.teardownSteps = a.teardownSteps;
  b.policy = { cleanup: "on-success" };
  assert.notEqual(computeIRHash(a), computeIRHash(b));
});

test("object key order does not change the hash", () => {
  const a = baseIR();
  const b: TestIR = {
    assertions: [{ oracle: "human-approved", contains: "saved", type: "ui", id: "ok" }],
    steps: [
      { path: "/", action: "navigate", id: "open" },
      { target: { testId: "save" }, action: "click", id: "click" },
    ],
    platform: "web",
    version: 1,
    id: "demo-hash",
  };
  assert.equal(computeIRHash(a), computeIRHash(b));
});

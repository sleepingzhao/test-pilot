import assert from "node:assert/strict";
import test from "node:test";
import { moveStep, parseStepJson, removeStepAt } from "./step-edit.js";

test("moveStep swaps adjacent steps", () => {
  const steps = [
    { id: "a", action: "navigate" as const, path: "/" },
    { id: "b", action: "click" as const, target: { role: "button", name: "Go" } },
  ];
  const moved = moveStep(steps, 0, 1);
  assert.equal(moved[0]?.id, "b");
  assert.equal(moved[1]?.id, "a");
});

test("removeStepAt drops index", () => {
  const steps = [
    { id: "a", action: "navigate" as const, path: "/" },
    { id: "b", action: "wait" as const },
  ];
  assert.equal(removeStepAt(steps, 0).length, 1);
});

test("parseStepJson validates required fields", () => {
  assert.equal(parseStepJson("{}").ok, false);
  const ok = parseStepJson('{"id":"s1","action":"navigate","path":"/"}');
  assert.equal(ok.ok, true);
});

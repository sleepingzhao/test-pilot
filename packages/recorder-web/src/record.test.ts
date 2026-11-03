import assert from "node:assert/strict";
import { test } from "node:test";
import { eventsToIR } from "./record.js";

test("eventsToIR builds duplicate-email flow", () => {
  const ir = eventsToIR("rec-demo", "http://127.0.0.1:4173/", [
    { kind: "navigate", path: "/" },
    { kind: "click", target: { role: "button", name: "Add user" } },
    { kind: "fill", target: { label: "Email" }, value: "duplicate@example.com" },
    { kind: "click", target: { role: "button", name: "Save" } },
  ]);
  assert.equal(ir.steps.length, 4);
  assert.equal(ir.steps[1]?.action, "click");
  assert.equal(ir.assertions[0]?.contains, "REPLACE_WITH_EXPECTED_TEXT");
});

import assert from "node:assert/strict";
import test from "node:test";
import { validateLlmStepsAgainstContext } from "./llm-steps.js";
import type { PageContext } from "./types.js";

const context: PageContext = {
  url: "http://127.0.0.1:4173/",
  elements: [
    { role: "button", name: "提交工单", testId: "open-ticket" },
    { role: "textbox", name: "联系电话", testId: "phone" },
  ],
};

test("rejects invented testId (negative)", () => {
  const out = validateLlmStepsAgainstContext(
    [{ id: "c1", action: "click", target: { testId: "not-on-page" } }],
    context,
  );
  assert.equal(out.ok, false);
});

test("accepts snapshot-backed click (positive)", () => {
  const out = validateLlmStepsAgainstContext(
    [
      { id: "n1", action: "navigate", path: "/" },
      { id: "c1", action: "click", target: { testId: "open-ticket" } },
    ],
    context,
  );
  assert.equal(out.ok, true);
  assert.equal(out.steps.length, 2);
});

test("rejects absolute navigate URL (negative)", () => {
  const out = validateLlmStepsAgainstContext(
    [{ id: "n1", action: "navigate", path: "https://evil.example/t" }],
    context,
  );
  assert.equal(out.ok, false);
});

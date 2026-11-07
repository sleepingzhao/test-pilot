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

test("rejects protocol-relative navigate path (negative)", () => {
  for (const path of ["//evil.example/t", "\\\\evil.example\\t"]) {
    const out = validateLlmStepsAgainstContext([{ id: "n1", action: "navigate", path }], context);
    assert.equal(out.ok, false, path);
  }
});

test("rejects ambiguous selector without testId (negative)", () => {
  const ambiguous: PageContext = {
    url: "http://127.0.0.1:4173/",
    elements: [
      { role: "button", name: "保存" },
      { role: "button", name: "保存" },
    ],
  };
  const out = validateLlmStepsAgainstContext(
    [{ id: "c1", action: "click", target: { role: "button", name: "保存" } }],
    ambiguous,
  );
  assert.equal(out.ok, false);
});

test("rejects literal password but accepts env ref (negative/positive)", () => {
  const form: PageContext = {
    url: "http://127.0.0.1:4173/",
    elements: [{ role: "textbox", name: "密码", testId: "password" }],
  };
  const literal = validateLlmStepsAgainstContext(
    [{ id: "f1", action: "fill", target: { testId: "password" }, value: "hunter2" }],
    form,
  );
  assert.equal(literal.ok, false);
  const envRef = validateLlmStepsAgainstContext(
    [{ id: "f2", action: "fill", target: { testId: "password" }, valueRef: "env.adminPassword" }],
    form,
  );
  assert.equal(envRef.ok, true);
});

test("accepts key-only press without target (positive)", () => {
  const out = validateLlmStepsAgainstContext([{ id: "p1", action: "press", value: "Enter" }], context);
  assert.equal(out.ok, true);
});

test("accepts dialog element by semantic locator with runtime warning", () => {
  const out = validateLlmStepsAgainstContext(
    [{ id: "c1", action: "click", target: { role: "button", name: "保存" } }],
    context,
  );
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.warnings.length, 1);
});

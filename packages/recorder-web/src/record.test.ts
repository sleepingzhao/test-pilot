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
  assert.equal(ir.baseUrl, "http://127.0.0.1:4173");
  assert.equal(ir.assertions[0]?.contains, "REPLACE_WITH_EXPECTED_TEXT");
});

test("sensitive fills map to env refs and never embed values", () => {
  const ir = eventsToIR("rec-login", "https://pilot.example.com/admin/login", [
    { kind: "fill", target: { label: "手机号" }, sensitive: true, fieldKey: "手机号" },
    { kind: "fill", target: { placeholder: "请输入密码" }, sensitive: true, fieldKey: "password" },
    { kind: "fill", target: { label: "验证码" }, sensitive: true, fieldKey: "验证码" },
  ]);
  assert.equal(ir.steps[0]?.valueRef, "env.adminPhone");
  assert.equal(ir.steps[1]?.valueRef, "env.adminPassword");
  assert.equal(ir.steps[2]?.valueRef, "fixture.secret");
  assert.ok(ir.steps.every((step) => step.value === undefined));
});

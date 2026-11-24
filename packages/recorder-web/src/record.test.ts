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

import { combineActorRecordings, splitLoginEvents } from "./record.js";
import type { RecordedEvent } from "./inject.js";

const PASSWORD = "TOP-SECRET-RECORDING";

function actorEvents(extra: RecordedEvent[]): RecordedEvent[] {
  return [
    { kind: "navigate", path: "/login" },
    { kind: "fill", target: { label: "企业编码" }, value: "ACME", fieldKey: "tenantCode" },
    { kind: "fill", target: { label: "账号" }, value: "user01", fieldKey: "userCode" },
    { kind: "fill", target: { label: "密码" }, value: PASSWORD, sensitive: true, fieldKey: "password" },
    { kind: "click", target: { name: "登录" } },
    { kind: "navigate", path: "/dashboard" },
    ...extra,
  ];
}

test("combineActorRecordings keeps login steps per actor and tags main steps", () => {
  const { ir, warnings } = combineActorRecordings("multi-rec", "http://127.0.0.1:9", [
    { actor: { id: "primary" }, events: actorEvents([{ kind: "click", target: { name: "新建" } }]) },
    {
      actor: { id: "b", account: "alt" },
      events: actorEvents([{ kind: "click", target: { name: "消息" } }]),
    },
  ]);

  assert.equal(ir.actors?.length, 2);
  const primary = ir.actors?.find((actor) => actor.id === "primary");
  const second = ir.actors?.find((actor) => actor.id === "b");
  assert.ok(primary?.loginSteps?.length);
  assert.ok(second?.loginSteps?.length);
  assert.equal(second?.account, "alt");
  assert.equal(primary?.loginSteps?.some((step) => step.valueRef === "env.adminPassword"), true);

  const primaryMain = ir.steps.find((step) => step.id === "open-page");
  assert.equal(primaryMain?.path, "/dashboard");
  assert.equal(primaryMain?.actor, undefined);
  const secondMain = ir.steps.find((step) => step.id.startsWith("b-"));
  assert.equal(secondMain?.actor, "b");

  const ids = ir.steps.map((step) => step.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(JSON.stringify(ir).includes(PASSWORD), false);
  assert.deepEqual(warnings, []);
});

test("splitLoginEvents removes login events and can return an empty login list", () => {
  const { login, main } = splitLoginEvents(actorEvents([]));
  assert.ok(login.length >= 5);
  assert.equal(main[0]?.kind, "navigate");
  assert.equal(main[0]?.kind === "navigate" ? main[0].path : "", "/dashboard");

  const plain = splitLoginEvents([{ kind: "navigate", path: "/app" }, { kind: "click", target: { name: "保存" } }]);
  assert.deepEqual(plain.login, []);
  assert.equal(plain.main.length, 2);
});

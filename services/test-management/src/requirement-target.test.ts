import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveRequirementTargetUrl,
  mergeRequirementSteps,
  pickObservedSuccessSignal,
} from "./requirement-target.js";

test("demo target resolves practice URL", () => {
  const r = resolveRequirementTargetUrl({
    target: "demo",
    demoUrl: "http://127.0.0.1:4173/",
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.url, "http://127.0.0.1:4173/");
});

test("pilot without config fails (negative)", () => {
  const r = resolveRequirementTargetUrl({
    target: "pilot",
    demoUrl: "http://127.0.0.1:4173/",
  });
  assert.equal(r.ok, false);
});

test("custom requires URL (negative)", () => {
  const r = resolveRequirementTargetUrl({
    target: "custom",
    demoUrl: "http://127.0.0.1:4173/",
  });
  assert.equal(r.ok, false);
});

test("real target uses the configured URL", () => {
  const r = resolveRequirementTargetUrl({
    target: "real",
    demoUrl: "http://127.0.0.1:4173/",
    realUrl: "https://real.example",
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.url, "https://real.example");
    assert.equal(r.label, "真实环境");
  }
});

test("real target without config fails (negative)", () => {
  const r = resolveRequirementTargetUrl({
    target: "real",
    demoUrl: "http://127.0.0.1:4173/",
  });
  assert.equal(r.ok, false);
});

test("pilot requirement steps are prefixed with login steps", () => {
  const login = [
    { id: "open-login", action: "navigate" as const, path: "/admin/login" },
    { id: "submit-login", action: "click" as const, target: { role: "button", name: "登录" } },
  ];
  const draft = [{ id: "open-target", action: "navigate" as const, path: "/customer" }];
  const merged = mergeRequirementSteps(true, login, draft);
  assert.deepEqual(
    merged.map((s) => s.id),
    ["login-open-login", "login-submit-login", "open-target"],
  );
  assert.equal(mergeRequirementSteps(false, login, draft).length, 1);
});

test("observed success signal only when steps passed and text is not weak", () => {
  const base = { steps: [{ status: "passed" }], finalSignals: ["成功", "用户已创建"] };
  assert.equal(pickObservedSuccessSignal({ ...base, status: "failed" }), "用户已创建");
  assert.equal(pickObservedSuccessSignal({ ...base, status: "passed" }), undefined);
  assert.equal(
    pickObservedSuccessSignal({
      status: "failed",
      steps: [{ status: "failed" }],
      finalSignals: ["用户已创建"],
    }),
    undefined,
  );
});

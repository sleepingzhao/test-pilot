import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateTestIR } from "@testpilot/test-ir";
import type { RecordedEvent } from "./inject.js";
import {
  assertRecordedIrHasNoPlaintextSecrets,
  eventsToIR,
  recorderLimitationWarnings,
} from "./record.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const PRACTICE_LOGIN_RECORD_EVENTS = JSON.parse(
  readFileSync(join(repoRoot, "examples/demo-webapp/recorder/practice-login-events.json"), "utf8"),
) as RecordedEvent[];

test("recorderLimitationWarnings flags cascader once and accepts native select", () => {
  const warnings = recorderLimitationWarnings([
    { kind: "fill", target: { label: "Region" }, value: "x", inputKind: "select" },
    { kind: "fill", target: { label: "Region2" }, value: "y", inputKind: "select" },
    { kind: "click", target: { testId: "cascader-x" }, limitation: "cascader" },
    { kind: "click", target: { testId: "cascader-y" }, limitation: "cascader" },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings.join(" "), /selectCascader/);
  assert.doesNotMatch(warnings.join(" "), /原生 <select>/);
});

test("eventsToIR login recording uses env refs and strips secrets from IR", () => {
  const ir = eventsToIR(
    "rec-practice-login",
    "http://127.0.0.1:4173/practice-login.html",
    PRACTICE_LOGIN_RECORD_EVENTS,
  );
  assertRecordedIrHasNoPlaintextSecrets(ir, PRACTICE_LOGIN_RECORD_EVENTS);
  assert.equal(ir.steps.find((s) => s.target?.label === "手机号")?.valueRef, "env.adminPhone");
  assert.equal(ir.steps.find((s) => s.target?.placeholder === "请输入密码")?.valueRef, "env.adminPassword");
  assert.ok(validateTestIR(ir).ok);
});

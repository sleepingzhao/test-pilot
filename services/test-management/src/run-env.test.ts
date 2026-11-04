import assert from "node:assert/strict";
import test from "node:test";
import type { TestIR } from "@testpilot/test-ir";
import { applyBaseUrlTarget, missingEnvRefs, resolveIrBaseUrl } from "./run-env.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const baseIR = (): TestIR => ({
  id: "demo-env",
  version: 1,
  platform: "web",
  steps: [],
  assertions: [],
});

test("unknown origins are pinned, pilot origins reuse the env ref", () => {
  withEnv({ TESTPILOT_PILOT_BASE_URL: "https://pilot.example.com" }, () => {
    const pinned = applyBaseUrlTarget(
      { ...baseIR(), baseUrlRef: "pilot-admin" },
      "https://staging.example.com/app",
    );
    assert.equal(pinned.baseUrl, "https://staging.example.com");
    assert.equal(pinned.baseUrlRef, undefined);

    const pilot = applyBaseUrlTarget(
      { ...baseIR(), baseUrl: "https://stale.example.com" },
      "https://pilot.example.com/admin/login",
    );
    assert.equal(pilot.baseUrlRef, "pilot-admin");
    assert.equal(pilot.baseUrl, undefined);
  });
});

test("missingEnvRefs reports only unset env refs", () => {
  withEnv(
    {
      TESTPILOT_ENV_ADMIN_PHONE: "13800138000",
      TESTPILOT_ENV_ADMIN_PASSWORD: undefined,
      TESTPILOT_FIXTURE_OTP: undefined,
    },
    () => {
      const ir: TestIR = {
        ...baseIR(),
        steps: [
          { id: "phone", action: "fill", target: { label: "手机号" }, valueRef: "env.adminPhone" },
          { id: "pass", action: "fill", target: { label: "密码" }, valueRef: "env.adminPassword" },
          { id: "otp", action: "fill", target: { label: "验证码" }, valueRef: "fixture.otp" },
          { id: "plain", action: "fill", target: { label: "备注" }, value: "ok" },
        ],
      };
      assert.deepEqual(missingEnvRefs(ir), [
        "TESTPILOT_ENV_ADMIN_PASSWORD",
        "TESTPILOT_FIXTURE_OTP",
      ]);
    },
  );
});

test("unconfigured baseUrlRef fails instead of falling back to the demo target", () => {
  const ir: TestIR = { ...baseIR(), baseUrlRef: "pilot-admin" };
  assert.throws(
    () => resolveIrBaseUrl(ir, { baseUrl: "http://127.0.0.1:4173", baseUrlRefs: {} }),
    /baseUrlRef "pilot-admin"/,
  );
});

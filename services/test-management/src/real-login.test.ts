import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_BASE_URL, pilotBaseUrl } from "./run-env.js";
import { isRealTarget, realLoginConfig } from "./real-login.js";

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

test("isRealTarget matches configured real origin only", () => {
  withEnv(
    {
      TESTPILOT_REAL_BASE_URL: "https://real.example.com",
      TESTPILOT_PILOT_BASE_URL: "https://pilot.example.com",
    },
    () => {
      assert.equal(isRealTarget("https://real.example.com/workspace"), true);
      assert.equal(isRealTarget("https://real.example.com"), true);
      assert.equal(isRealTarget(DEMO_BASE_URL), false);
      assert.equal(isRealTarget(pilotBaseUrl() || "https://pilot.example.com"), false);
      assert.equal(isRealTarget(""), false);
      assert.equal(isRealTarget("https://other.example.com"), false);
    },
  );
});

test("isRealTarget is false when real base URL is unset", () => {
  withEnv({ TESTPILOT_REAL_BASE_URL: undefined }, () => {
    assert.equal(isRealTarget("https://real.example.com"), false);
  });
});
test("realLoginConfig reads the primary and alt credential sets separately", () => {
  withEnv(
    {
      TESTPILOT_ENV_REAL_ENTERPRISE_ID: "E1",
      TESTPILOT_ENV_REAL_USER_ID: "U1",
      TESTPILOT_ENV_REAL_PASSWORD: "P1",
      TESTPILOT_ENV_REAL_ALT_ENTERPRISE_ID: "E2",
      TESTPILOT_ENV_REAL_ALT_USER_ID: "U2",
      TESTPILOT_ENV_REAL_ALT_PASSWORD: "P2",
    },
    () => {
      assert.deepEqual(realLoginConfig("primary"), { enterpriseId: "E1", userId: "U1", password: "P1" });
      assert.deepEqual(realLoginConfig("alt"), { enterpriseId: "E2", userId: "U2", password: "P2" });
      assert.deepEqual(realLoginConfig(), { enterpriseId: "E1", userId: "U1", password: "P1" });
    },
  );
});

test("realLoginConfig does not fall back between accounts", () => {
  withEnv(
    {
      TESTPILOT_ENV_REAL_ENTERPRISE_ID: "E1",
      TESTPILOT_ENV_REAL_USER_ID: "U1",
      TESTPILOT_ENV_REAL_PASSWORD: "P1",
      TESTPILOT_ENV_REAL_ALT_ENTERPRISE_ID: undefined,
      TESTPILOT_ENV_REAL_ALT_USER_ID: undefined,
      TESTPILOT_ENV_REAL_ALT_PASSWORD: undefined,
    },
    () => {
      assert.equal(realLoginConfig("alt"), null);
      assert.ok(realLoginConfig("primary"));
    },
  );
});

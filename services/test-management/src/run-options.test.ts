import assert from "node:assert/strict";
import test from "node:test";
import type { TestIR } from "@testpilot/test-ir";
import { DEMO_BASE_URL, pilotBaseUrl } from "./run-env.js";
import { shouldReadOnlyNetwork, runOptionsFor } from "./read-only-run.js";

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

const minimalIr = (policy?: TestIR["policy"]): Pick<TestIR, "policy"> => ({ policy });

test("shouldReadOnlyNetwork: real origin without allowMutation is read-only", () => {
  withEnv({ TESTPILOT_REAL_BASE_URL: "https://real.example.com" }, () => {
    assert.equal(shouldReadOnlyNetwork("https://real.example.com/workspace", minimalIr().policy), true);
    assert.equal(shouldReadOnlyNetwork("https://real.example.com", minimalIr({}).policy), true);
  });
});

test("shouldReadOnlyNetwork: allowMutation true disables guard on real origin", () => {
  withEnv({ TESTPILOT_REAL_BASE_URL: "https://real.example.com" }, () => {
    assert.equal(shouldReadOnlyNetwork("https://real.example.com", minimalIr({ allowMutation: true }).policy), false);
  });
});

test("shouldReadOnlyNetwork: demo, pilot, and custom origins are not read-only", () => {
  withEnv(
    {
      TESTPILOT_REAL_BASE_URL: "https://real.example.com",
      TESTPILOT_PILOT_BASE_URL: "https://pilot.example.com",
    },
    () => {
      assert.equal(shouldReadOnlyNetwork(DEMO_BASE_URL, minimalIr().policy), false);
      assert.equal(shouldReadOnlyNetwork(pilotBaseUrl() || "https://pilot.example.com", minimalIr().policy), false);
      assert.equal(shouldReadOnlyNetwork("https://other.example.com", minimalIr().policy), false);
    },
  );
});

test("runOptionsFor sets readOnlyNetwork and login for real targets", () => {
  withEnv({ TESTPILOT_REAL_BASE_URL: "https://real.example.com" }, () => {
    const opts = runOptionsFor("https://real.example.com", "run_x", "/tmp/art", minimalIr());
    assert.equal(opts.readOnlyNetwork, true);
    assert.equal(typeof opts.login, "function");
  });
});

test("runOptionsFor omits readOnlyNetwork when allowMutation is true", () => {
  withEnv({ TESTPILOT_REAL_BASE_URL: "https://real.example.com" }, () => {
    const opts = runOptionsFor(
      "https://real.example.com",
      "run_x",
      "/tmp/art",
      minimalIr({ allowMutation: true }),
    );
    assert.equal(opts.readOnlyNetwork, undefined);
  });
});
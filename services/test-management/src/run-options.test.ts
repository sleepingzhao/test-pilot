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

const minimalIr = (
  policy?: TestIR["policy"],
): Pick<TestIR, "policy" | "baseUrl" | "baseUrlRef" | "actors"> => ({
  policy,
  baseUrl: undefined,
  baseUrlRef: undefined,
  actors: undefined,
});

test("shouldReadOnlyNetwork: off by default even on a real origin", () => {
  withEnv({ TESTPILOT_REAL_BASE_URL: "https://real.example.com", TESTPILOT_READONLY: undefined }, () => {
    assert.equal(shouldReadOnlyNetwork("https://real.example.com/workspace", undefined), false);
    assert.equal(shouldReadOnlyNetwork("https://real.example.com", minimalIr({}).policy), false);
  });
});

test("shouldReadOnlyNetwork: TESTPILOT_READONLY=1 enables the guard on real origins", () => {
  withEnv(
    { TESTPILOT_REAL_BASE_URL: "https://real.example.com", TESTPILOT_READONLY: "1" },
    () => {
      assert.equal(shouldReadOnlyNetwork("https://real.example.com/workspace"), true);
      assert.equal(shouldReadOnlyNetwork("https://real.example.com", minimalIr({}).policy), true);
    },
  );
});

test("shouldReadOnlyNetwork: allowMutation true disables the guard even when enabled", () => {
  withEnv(
    { TESTPILOT_REAL_BASE_URL: "https://real.example.com", TESTPILOT_READONLY: "1" },
    () => {
      assert.equal(
        shouldReadOnlyNetwork("https://real.example.com", minimalIr({ allowMutation: true }).policy),
        false,
      );
    },
  );
});

test("shouldReadOnlyNetwork: demo, pilot, and custom origins are never read-only", () => {
  withEnv(
    {
      TESTPILOT_REAL_BASE_URL: "https://real.example.com",
      TESTPILOT_PILOT_BASE_URL: "https://pilot.example.com",
      TESTPILOT_READONLY: "1",
    },
    () => {
      assert.equal(shouldReadOnlyNetwork(DEMO_BASE_URL, minimalIr().policy), false);
      assert.equal(shouldReadOnlyNetwork(pilotBaseUrl() || "https://pilot.example.com", minimalIr().policy), false);
      assert.equal(shouldReadOnlyNetwork("https://other.example.com", minimalIr().policy), false);
    },
  );
});

test("runOptionsFor: real targets run normally by default and log in", () => {
  withEnv({ TESTPILOT_REAL_BASE_URL: "https://real.example.com", TESTPILOT_READONLY: undefined }, () => {
    const opts = runOptionsFor("https://real.example.com", "run_x", "/tmp/art", minimalIr());
    assert.equal(opts.readOnlyNetwork, undefined);
    assert.equal(opts.realTarget, true);
    assert.equal(typeof opts.login, "function");
  });
});

test("runOptionsFor: TESTPILOT_READONLY=1 enables the guard on real targets", () => {
  withEnv(
    { TESTPILOT_REAL_BASE_URL: "https://real.example.com", TESTPILOT_READONLY: "1" },
    () => {
      const opts = runOptionsFor("https://real.example.com", "run_x", "/tmp/art", minimalIr());
      assert.equal(opts.readOnlyNetwork, true);
    },
  );
});

test("runOptionsFor omits readOnlyNetwork when allowMutation is true", () => {
  withEnv(
    { TESTPILOT_REAL_BASE_URL: "https://real.example.com", TESTPILOT_READONLY: "1" },
    () => {
      const opts = runOptionsFor(
        "https://real.example.com",
        "run_x",
        "/tmp/art",
        minimalIr({ allowMutation: true }),
      );
      assert.equal(opts.readOnlyNetwork, undefined);
    },
  );
});
test("runOptionsFor resolves the IR's baseUrlRef, not the demo fallback", () => {
  withEnv({ TESTPILOT_REAL_BASE_URL: "https://real.example.com", TESTPILOT_READONLY: undefined }, () => {
    const opts = runOptionsFor(DEMO_BASE_URL, "run_x", "/tmp/art", {
      ...minimalIr(),
      baseUrlRef: "real-env",
    });
    assert.equal(opts.realTarget, true);
    assert.equal(typeof opts.login, "function");
  });
});

test("runOptionsFor honors a primary actor's own baseUrl", () => {
  withEnv({ TESTPILOT_REAL_BASE_URL: "https://real.example.com", TESTPILOT_READONLY: undefined }, () => {
    const opts = runOptionsFor(DEMO_BASE_URL, "run_x", "/tmp/art", {
      ...minimalIr(),
      actors: [{ id: "primary", baseUrl: "https://real.example.com" }],
    });
    assert.equal(opts.realTarget, true);
  });
});

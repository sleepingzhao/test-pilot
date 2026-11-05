import assert from "node:assert/strict";
import test from "node:test";
import { maxRunAttempts, normalizeRetryKind, shouldRetryAfterFailure } from "./retry-policy.js";

test("normalizeRetryKind maps transient-network to ENVIRONMENT", () => {
  assert.equal(normalizeRetryKind("transient-network"), "ENVIRONMENT");
});

test("shouldRetryAfterFailure never retries assertion failures", () => {
  assert.equal(
    shouldRetryAfterFailure(
      {
        status: "failed",
        failureKind: "ENVIRONMENT",
        assertions: [{ passed: false }],
      },
      { attempts: 1, on: ["ENVIRONMENT"] },
    ),
    false,
  );
});

test("shouldRetryAfterFailure respects retry.on failure kinds", () => {
  assert.equal(
    shouldRetryAfterFailure(
      { status: "failed", failureKind: "ENVIRONMENT", assertions: [] },
      { attempts: 1, on: ["ENVIRONMENT"] },
    ),
    true,
  );
  assert.equal(
    shouldRetryAfterFailure(
      { status: "failed", failureKind: "LOCATOR_BREAKAGE", assertions: [] },
      { attempts: 1, on: ["ENVIRONMENT"] },
    ),
    false,
  );
  assert.equal(
    shouldRetryAfterFailure(
      { status: "failed", failureKind: "ENVIRONMENT", assertions: [] },
      { attempts: 1, on: ["transient-network"] },
    ),
    true,
  );
});

test("maxRunAttempts caps extra retries at 5", () => {
  assert.equal(maxRunAttempts({ attempts: 1, on: ["ENVIRONMENT"] }), 2);
  assert.equal(maxRunAttempts({ attempts: 99, on: ["ENVIRONMENT"] }), 6);
  assert.equal(maxRunAttempts(undefined), 1);
});

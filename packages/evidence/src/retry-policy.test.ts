import assert from "node:assert/strict";
import test from "node:test";
import { classifyFailure } from "./index.js";
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

test("legacy retry attempts without on still retries transient environment failures", () => {
  assert.equal(
    shouldRetryAfterFailure(
      { status: "failed", failureKind: "ENVIRONMENT", assertions: [] },
      { attempts: 1 },
    ),
    true,
  );
  assert.equal(
    shouldRetryAfterFailure(
      { status: "failed", failureKind: "LOCATOR_BREAKAGE", assertions: [] },
      { attempts: 1 },
    ),
    false,
  );
  assert.equal(
    shouldRetryAfterFailure(
      { status: "failed", failureKind: "ENVIRONMENT", assertions: [] },
      { attempts: 1, on: [] },
    ),
    false,
  );
});

test("reads failureKind from a RunResult metrics object", () => {
  assert.equal(
    shouldRetryAfterFailure(
      { status: "failed", metrics: { failureKind: "ENVIRONMENT" }, assertions: [] },
      { attempts: 1, on: ["ENVIRONMENT"] },
    ),
    true,
  );
});

test("Playwright-style Timeout errors classify as ENVIRONMENT", () => {
  assert.equal(
    classifyFailure({ stepError: "page.click: Timeout 30000ms exceeded." }),
    "ENVIRONMENT",
  );
  assert.equal(classifyFailure({ stepError: "net::ERR_CONNECTION_RESET" }), "ENVIRONMENT");
  assert.equal(
    classifyFailure({ stepError: "tracing.stop: Target page, context or browser has been closed" }),
    "ENVIRONMENT",
  );
  assert.equal(
    classifyFailure({ stepError: "locator.click: strict mode violation" }),
    "LOCATOR_BREAKAGE",
  );
  assert.equal(classifyFailure({ assertionMessage: "expected 201, got 500" }), "PRODUCT_DEFECT");
});

test("maxRunAttempts caps extra retries at 5", () => {
  assert.equal(maxRunAttempts({ attempts: 1, on: ["ENVIRONMENT"] }), 2);
  assert.equal(maxRunAttempts({ attempts: 99, on: ["ENVIRONMENT"] }), 6);
  assert.equal(maxRunAttempts(undefined), 1);
});

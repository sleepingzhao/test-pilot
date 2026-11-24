import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { runUiAssertion } from "./index.js";
import type { AssertionContext } from "./types.js";

function fakePage(count: number): Page {
  return {
    getByRole: () => ({ count: async () => count }),
  } as unknown as Page;
}

const ctx = (count: number) =>
  ({ page: fakePage(count), network: [], resolveRequestRef: () => undefined }) as unknown as AssertionContext;

process.env.TESTPILOT_UI_ASSERT_TIMEOUT_MS = "0";

test("minCount passes when enough elements match", async () => {
  const outcome = await runUiAssertion(
    { id: "rows", type: "ui", target: { role: "row" }, minCount: 2, oracle: "human-approved" },
    ctx(3),
  );
  assert.equal(outcome.passed, true);
  assert.equal(outcome.actual, "3");
});

test("minCount fails when too few elements match", async () => {
  const outcome = await runUiAssertion(
    { id: "rows", type: "ui", target: { role: "row" }, minCount: 2, oracle: "human-approved" },
    ctx(1),
  );
  assert.equal(outcome.passed, false);
  assert.equal(outcome.errorKind, "PRODUCT_DEFECT");
  assert.equal(outcome.actual, "1");
  assert.match(outcome.message ?? "", /at least 2 elements/);
});

test("minCount fails when no element matches", async () => {
  const outcome = await runUiAssertion(
    { id: "rows", type: "ui", target: { role: "row" }, minCount: 2, oracle: "human-approved" },
    ctx(0),
  );
  assert.equal(outcome.passed, false);
  assert.equal(outcome.errorKind, "PRODUCT_DEFECT");
});

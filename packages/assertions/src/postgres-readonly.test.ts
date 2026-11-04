import assert from "node:assert/strict";
import test from "node:test";
import { createReadonlyDbClient, assertSafeReadonlySql, bindNamedParams } from "@testpilot/fixtures";
import {
  runPostgresReadonlyAssertion,
  validatePostgresReadonlyAssertion,
} from "./postgres-readonly.js";

const configs = {
  "pilot-db": {
    connectionRef: "env.PILOT_DB_URL",
    allowedTables: ["work_order"],
    queries: {
      "order-by-run-id": "SELECT id, status FROM work_order WHERE ref = :runId",
    },
  },
};

test("assertSafeReadonlySql rejects non-SELECT", () => {
  assert.throws(() => assertSafeReadonlySql("DELETE FROM work_order", ["work_order"]));
});

test("bindNamedParams produces positional placeholders", () => {
  const { text, values } = bindNamedParams("SELECT * FROM work_order WHERE ref = :runId", {
    runId: "r1",
  });
  assert.match(text, /\$1/);
  assert.deepEqual(values, ["r1"]);
});

test("validatePostgresReadonlyAssertion requires queryRef and config", () => {
  const issues = validatePostgresReadonlyAssertion(
    {
      type: "db",
      provider: "postgres-readonly",
      configRef: "pilot-db",
      oracle: "human-approved",
      expect: {},
    },
    (ref) => configs[ref as keyof typeof configs],
  );
  assert.ok(issues.some((i) => i.path.includes("queryRef")));
});

test("runPostgresReadonlyAssertion passes row match", async () => {
  const db = createReadonlyDbClient({
    configs,
    mockExecute: async (_configRef, queryRef, params) => {
      assert.equal(queryRef, "order-by-run-id");
      assert.equal(params.runId, "run_abc");
      return { rowCount: 1, rows: [{ id: "1", status: "SUBMITTED" }] };
    },
  });

  const outcome = await runPostgresReadonlyAssertion(
    {
      id: "db1",
      type: "db",
      provider: "postgres-readonly",
      configRef: "pilot-db",
      oracle: "human-approved",
      expect: { queryRef: "order-by-run-id", rowCount: 1, row: { status: "SUBMITTED" } },
    },
    { page: {} as import("playwright").Page, runId: "run_abc", db },
  );
  assert.equal(outcome.passed, true);
  assert.equal((outcome.actual as { rowCount: number }).rowCount, 1);
});

test("runPostgresReadonlyAssertion fails on rowCount (negative)", async () => {
  const db = createReadonlyDbClient({
    configs,
    mockExecute: async () => ({ rowCount: 0, rows: [] }),
  });

  const outcome = await runPostgresReadonlyAssertion(
    {
      id: "db1",
      type: "db",
      provider: "postgres-readonly",
      configRef: "pilot-db",
      oracle: "human-approved",
      expect: { queryRef: "order-by-run-id", rowCount: 1 },
    },
    { page: {} as import("playwright").Page, runId: "run_x", db },
  );
  assert.equal(outcome.passed, false);
  assert.equal(outcome.errorKind, "PRODUCT_DEFECT");
});

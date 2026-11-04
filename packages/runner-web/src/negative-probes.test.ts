import assert from "node:assert/strict";
import test from "node:test";
import { evaluateNegativeProbeRun } from "./negative-probes.js";
import type { RunResult } from "./run.js";

test("evaluateNegativeProbeRun passes when run failed with failing assertion", () => {
  const run = {
    status: "failed",
    assertions: [{ assertionId: "a1", passed: false, errorKind: "PRODUCT_DEFECT" }],
  } as RunResult;
  const result = evaluateNegativeProbeRun(
    { id: "p1", provider: "playwright-ui", file: "x.json" },
    run,
  );
  assert.equal(result.ok, true);
});

test("evaluateNegativeProbeRun fails when run passed", () => {
  const run = {
    status: "passed",
    assertions: [{ assertionId: "a1", passed: true }],
  } as RunResult;
  const result = evaluateNegativeProbeRun(
    { id: "p1", provider: "playwright-ui", file: "x.json" },
    run,
  );
  assert.equal(result.ok, false);
});

test("evaluateNegativeProbeRun rejects ENVIRONMENT failure (negative)", () => {
  const run = {
    status: "failed",
    assertions: [{ assertionId: "a1", passed: false, errorKind: "ENVIRONMENT" }],
  } as RunResult;
  const result = evaluateNegativeProbeRun(
    { id: "p1", provider: "playwright-ui", file: "x.json" },
    run,
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "ENVIRONMENT");
});

test("evaluateNegativeProbeRun rejects ASSERTION_ORACLE failure (negative)", () => {
  const run = {
    status: "failed",
    assertions: [{ assertionId: "a1", passed: false, errorKind: "ASSERTION_ORACLE" }],
  } as RunResult;
  const result = evaluateNegativeProbeRun(
    { id: "p1", provider: "captured-http", file: "x.json" },
    run,
  );
  assert.equal(result.ok, false);
});

test("evaluateNegativeProbeRun accepts PRODUCT_DEFECT failure", () => {
  const run = {
    status: "failed",
    assertions: [{ assertionId: "a1", passed: false, errorKind: "PRODUCT_DEFECT" }],
  } as RunResult;
  const result = evaluateNegativeProbeRun(
    { id: "p1", provider: "playwright-ui", file: "x.json" },
    run,
  );
  assert.equal(result.ok, true);
});

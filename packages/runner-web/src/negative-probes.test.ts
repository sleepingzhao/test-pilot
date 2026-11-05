import assert from "node:assert/strict";
import test from "node:test";
import { evaluateNegativeProbeRun } from "./negative-probes.js";
import type { RunResult } from "./run.js";

const baseSpec = {
  id: "p1",
  provider: "playwright-ui",
  file: "x.json",
  expectedAssertionId: "a1",
};

test("evaluateNegativeProbeRun passes when run failed with failing assertion", () => {
  const run = {
    status: "failed",
    assertions: [{ assertionId: "a1", passed: false, errorKind: "PRODUCT_DEFECT" }],
  } as RunResult;
  const result = evaluateNegativeProbeRun(baseSpec, run);
  assert.equal(result.ok, true);
});

test("evaluateNegativeProbeRun fails when run passed", () => {
  const run = {
    status: "passed",
    assertions: [{ assertionId: "a1", passed: true }],
  } as RunResult;
  const result = evaluateNegativeProbeRun(baseSpec, run);
  assert.equal(result.ok, false);
});

test("evaluateNegativeProbeRun rejects ENVIRONMENT failure (negative)", () => {
  const run = {
    status: "failed",
    assertions: [{ assertionId: "a1", passed: false, errorKind: "ENVIRONMENT" }],
  } as RunResult;
  const result = evaluateNegativeProbeRun(baseSpec, run);
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "ENVIRONMENT");
});

test("evaluateNegativeProbeRun rejects ASSERTION_ORACLE failure (negative)", () => {
  const run = {
    status: "failed",
    assertions: [{ assertionId: "a1", passed: false, errorKind: "ASSERTION_ORACLE" }],
  } as RunResult;
  const result = evaluateNegativeProbeRun(baseSpec, run);
  assert.equal(result.ok, false);
});

test("evaluateNegativeProbeRun accepts PRODUCT_DEFECT failure", () => {
  const run = {
    status: "failed",
    assertions: [{ assertionId: "a1", passed: false, errorKind: "PRODUCT_DEFECT" }],
  } as RunResult;
  const result = evaluateNegativeProbeRun(baseSpec, run);
  assert.equal(result.ok, true);
});

test("evaluateNegativeProbeRun rejects wrong expectedAssertionId (negative)", () => {
  const run = {
    status: "failed",
    assertions: [{ assertionId: "other-id", passed: false, errorKind: "PRODUCT_DEFECT" }],
  } as RunResult;
  const result = evaluateNegativeProbeRun(baseSpec, run);
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /expected failed assertion id a1/);
});

test("evaluateNegativeProbeRun accepts expectedAssertionId with PRODUCT_DEFECT (positive)", () => {
  const run = {
    status: "failed",
    assertions: [
      { assertionId: "noise", passed: true },
      { assertionId: "a1", passed: false, errorKind: "PRODUCT_DEFECT" },
    ],
  } as RunResult;
  const result = evaluateNegativeProbeRun(baseSpec, run);
  assert.equal(result.ok, true);
});

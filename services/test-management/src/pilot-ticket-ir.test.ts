import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runCapturedHttpAssertion, validateCapturedHttpAssertion } from "@testpilot/assertions";
import { validateTestIR } from "@testpilot/test-ir";
import type { TestIR } from "@testpilot/test-ir";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const pilotIrPath = join(repoRoot, "examples/pilot-admin/tests/pilot-ticket-submit-success.json");

test("pilot-ticket-submit-success IR validates (draft template)", async () => {
  const raw = await readFile(pilotIrPath, "utf8");
  const ir = JSON.parse(raw) as TestIR;
  const v = validateTestIR(ir);
  assert.equal(v.ok, true);
  assert.ok(ir.assertions?.some((a) => a.id === "ticket-submit-success-db"));
});

test("pilot ticket HTTP assertion fails on wrong status (negative)", async () => {
  const assertion = {
    id: "ticket-submit-success-api",
    type: "api" as const,
    provider: "captured-http",
    requestRef: "pilot-ticket-submit",
    expect: { statusCode: 200 },
    oracle: "api-contract" as const,
  };
  assert.equal(validateCapturedHttpAssertion(assertion).length, 0);
  const outcome = await runCapturedHttpAssertion(assertion, {
    page: {} as import("playwright").Page,
    network: [
      {
        url: "https://pilot.example/workorder/create",
        method: "POST",
        status: 500,
        resourceType: "xhr",
        requestBody: "TestPilot-run1",
      },
    ],
    resolveRequestRef: () => ({ urlIncludes: "/workorder", method: "POST" }),
  });
  assert.equal(outcome.passed, false);
  assert.ok(outcome.errorKind === "ASSERTION_ORACLE" || outcome.errorKind === "PRODUCT_DEFECT");
});

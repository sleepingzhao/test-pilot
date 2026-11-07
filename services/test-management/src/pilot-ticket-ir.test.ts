import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runCapturedHttpAssertion, validateCapturedHttpAssertion } from "@testpilot/assertions";
import { resolveRequestRef } from "@testpilot/fixtures";
import { validateTestIR } from "@testpilot/test-ir";
import type { TestIR } from "@testpilot/test-ir";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const pilotIrPath = join(repoRoot, "examples/pilot-admin/tests/pilot-ticket-submit-success.json");

const page = {} as import("playwright").Page;
const resolvePilotRef = () => resolveRequestRef("pilot-ticket-submit", { baseUrl: "https://pilot.example" })!;

test("pilot-ticket-submit-success IR validates as a reviewable draft", async () => {
  const raw = await readFile(pilotIrPath, "utf8");
  const ir = JSON.parse(raw) as TestIR;
  const v = validateTestIR(ir);
  assert.equal(v.ok, true);
  assert.ok(ir.assertions?.some((a) => a.type === "ui"));
  assert.ok(ir.assertions?.some((a) => a.id === "ticket-submit-success-api"));
  // DB proof is optional until a readonly DB config exists; do not block the draft.
  assert.equal(ir.assertions?.some((a) => a.type === "db"), false);
});

test("pilot ticket HTTP assertion fails when the configured expectation is not met", async () => {
  const raw = await readFile(pilotIrPath, "utf8");
  const ir = JSON.parse(raw) as TestIR;
  const assertion = ir.assertions.find((a) => a.id === "ticket-submit-success-api")!;
  assert.equal(validateCapturedHttpAssertion(assertion).length, 0);

  const wrongStatus = await runCapturedHttpAssertion(assertion, {
    page,
    network: [
      {
        url: "https://pilot.example/api/workorder/workOrder/create",
        method: "POST",
        status: 500,
        resourceType: "xhr",
        requestBody: "TestPilot-run1",
      },
    ],
    resolveRequestRef: resolvePilotRef,
  });
  assert.equal(wrongStatus.passed, false);

  const wrongBody = await runCapturedHttpAssertion(assertion, {
    page,
    network: [
      {
        url: "https://pilot.example/api/workorder/workOrder/create",
        method: "POST",
        status: 200,
        resourceType: "xhr",
        requestBody: "manual-body-without-marker",
      },
    ],
    resolveRequestRef: resolvePilotRef,
  });
  assert.equal(wrongBody.passed, false);

  const ok = await runCapturedHttpAssertion(assertion, {
    page,
    network: [
      {
        url: "https://pilot.example/api/workorder/workOrder/create",
        method: "POST",
        status: 200,
        resourceType: "xhr",
        requestBody: "TestPilot-run1",
      },
    ],
    resolveRequestRef: resolvePilotRef,
  });
  assert.equal(ok.passed, true);
});

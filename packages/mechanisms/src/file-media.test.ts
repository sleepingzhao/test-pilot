import assert from "node:assert/strict";
import test from "node:test";
import { validateAssertionProviders } from "@testpilot/assertions";
import { validateSemantics, validateTestIR } from "@testpilot/test-ir";
import { planFileMedia, type FileMediaContext, type FileMediaProfile } from "./index.js";

const ready: FileMediaProfile = {
  capabilities: [
    { id: "crud", confidence: 0.95 },
    { id: "file-media", confidence: 0.6 },
  ],
};

const ctx: FileMediaContext = {
  uploadRef: "fixture.samplePng",
  fileName: "pixel.png",
  uploadRequestRef: "files-upload",
  invalidTypeRef: "fixture.sampleTxt",
  invalidTypeName: "notes.txt",
  oversizeRef: "fixture.sampleHuge",
  oversizeName: "huge.png",
};

test("file-media is not runnable without a capability at confidence 0.6", () => {
  const missing = planFileMedia({ capabilities: [{ id: "crud", confidence: 0.99 }] }, ctx);
  assert.equal(missing.mechanism, "file-media");
  assert.equal(missing.runnable, false);
  assert.equal(missing.scenarios.length, 0);
  assert.match(missing.blockers.join("\n"), /file-media/);
  assert.match(missing.blockers.join("\n"), /0\.6/);
  assert.equal(JSON.stringify(missing).includes("fixture.samplePng"), false);

  const low = planFileMedia({ capabilities: [{ id: "file-media", confidence: 0.59 }] }, ctx);
  assert.equal(low.runnable, false);
  assert.equal(low.scenarios.length, 0);
  assert.match(low.blockers.join("\n"), /0\.59/);
});

test("happy IR validates and does not embed paths or secrets", () => {
  const secret = "sk-test-secret-do-not-emit";
  const plan = planFileMedia(ready, ctx);
  assert.equal(plan.runnable, true);
  assert.deepEqual(
    plan.scenarios.map((scenario) => scenario.kind),
    ["happy", "invalid-type", "oversize"],
  );
  const happy = plan.scenarios[0]!;
  assert.equal(happy.id, "happy");
  assert.deepEqual(
    happy.ir.steps.map((step) => step.action),
    ["navigate", "upload", "click"],
  );
  assert.equal(happy.ir.steps[1]?.valueRef, "fixture.samplePng");
  assert.equal(happy.ir.steps[1]?.value, undefined);
  assert.deepEqual(happy.ir.steps[1]?.target, { testId: "file-input" });
  assert.deepEqual(happy.ir.steps[2]?.target, { testId: "file-upload-submit" });
  const api = happy.ir.assertions.find((assertion) => assertion.type === "api");
  const ui = happy.ir.assertions.find((assertion) => assertion.type === "ui");
  assert.equal(api?.requestRef, "files-upload");
  assert.deepEqual(api?.expect, { statusCode: 201, responseJsonBody: { name: "pixel.png" } });
  assert.equal(ui?.contains, "pixel.png");
  assert.deepEqual(ui?.target, { testId: "file-list" });

  const validated = validateTestIR(happy.ir);
  assert.equal(validated.ok, true, JSON.stringify(validated.ok ? {} : validated.issues));
  if (validated.ok) assert.deepEqual(validateSemantics(validated.value), []);
  assert.deepEqual(validateAssertionProviders(happy.ir), []);

  for (const scenario of plan.scenarios) {
    const result = validateTestIR(scenario.ir);
    assert.equal(result.ok, true, `${scenario.id} ${JSON.stringify(result.ok ? {} : result.issues)}`);
    if (result.ok) assert.deepEqual(validateSemantics(result.value), []);
    assert.deepEqual(validateAssertionProviders(scenario.ir), []);
    const raw = JSON.stringify(scenario.ir);
    assert.equal(raw.includes(secret), false);
    assert.equal(raw.includes("/Users/"), false);
    assert.equal(raw.includes("TESTPILOT_"), false);
    assert.equal(/[A-Za-z]:\\/.test(raw), false);
    assert.equal(raw.includes("://"), false);
  }

  const invalid = plan.scenarios.find((scenario) => scenario.kind === "invalid-type")!;
  assert.deepEqual(invalid.ir.assertions[0]?.expect, {
    statusCode: 415,
    responseJsonBody: { error: "unsupported_type" },
  });
  const oversize = plan.scenarios.find((scenario) => scenario.kind === "oversize")!;
  assert.deepEqual(oversize.ir.assertions[0]?.expect, { statusCode: 413 });
  assert.equal(JSON.stringify(plan).includes(secret), false);
});

test("missing optional fixtures skip those scenarios and explain why", () => {
  const plan = planFileMedia(ready, {
    uploadRef: "fixture.samplePng",
    fileName: "pixel.png",
    uploadRequestRef: "files-upload",
  });
  assert.equal(plan.runnable, true);
  assert.deepEqual(
    plan.scenarios.map((scenario) => scenario.id),
    ["happy"],
  );
  const notes = plan.blockers.join("\n");
  assert.match(notes, /invalid-type/);
  assert.match(notes, /invalidTypeRef/);
  assert.match(notes, /oversize/);
  assert.match(notes, /oversizeRef/);
});

test("cleanup adds saveFields, teardown, and cleanup policy to the happy IR", () => {
  const plan = planFileMedia(ready, {
    ...ctx,
    cleanup: { path: "/api/files/{{uploadedId}}", method: "DELETE", idField: "id" },
  });
  assert.equal(plan.runnable, true);
  const happy = plan.scenarios.find((scenario) => scenario.kind === "happy")!;
  const submit = happy.ir.steps.find((step) => step.id === "submit-upload");
  assert.equal(submit?.saveFromRef, "files-upload");
  assert.deepEqual(submit?.saveFields, { uploadedId: "id" });
  assert.equal(happy.ir.policy?.cleanup, "always");
  assert.deepEqual(happy.ir.teardownSteps, [
    { id: "cleanup", action: "request", method: "DELETE", path: "/api/files/{{uploadedId}}" },
  ]);
  const validated = validateTestIR(happy.ir);
  assert.equal(validated.ok, true, JSON.stringify(validated.ok ? {} : validated.issues));
  if (validated.ok) assert.deepEqual(validateSemantics(validated.value), []);
  assert.equal(JSON.stringify(happy.ir).includes("/Users/"), false);

  const invalidScenarios = plan.scenarios.filter((scenario) => scenario.kind !== "happy");
  for (const scenario of invalidScenarios) {
    assert.equal(scenario.ir.teardownSteps, undefined);
  }
});

test("invalid cleanup config is reported and never generates a teardown", () => {
  const plan = planFileMedia(ready, {
    ...ctx,
    cleanup: { path: "https://evil.example/files/{{uploadedId}}" },
  });
  assert.match(plan.blockers.join("\n"), /cleanupPath/);
  const happy = plan.scenarios.find((scenario) => scenario.kind === "happy")!;
  assert.equal(happy.ir.teardownSteps, undefined);
  assert.equal(happy.ir.policy?.cleanup, undefined);

  const wrongPlaceholder = planFileMedia(ready, {
    ...ctx,
    cleanup: { path: "/api/files/fixed-id" },
  });
  assert.match(wrongPlaceholder.blockers.join("\n"), /\{\{uploadedId\}\}/);
});

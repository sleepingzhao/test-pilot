import assert from "node:assert/strict";
import test from "node:test";
import type { TestStep } from "@testpilot/test-ir";
import {
  assignResponseVariables,
  lookupProcessEnv,
  redactSecretValues,
  renderRequestStep,
  type TemplateContext,
} from "./request-template.js";

function ctx(partial?: Partial<TemplateContext>): TemplateContext {
  return {
    runId: "run-1",
    vars: { userId: "user-1" },
    lookupEnv: (logicalKey) =>
      logicalKey === "v7Token"
        ? { name: "TESTPILOT_ENV_V7TOKEN", value: "sekret-value" }
        : { name: `TESTPILOT_ENV_${logicalKey.toUpperCase()}`, value: undefined },
    secrets: [],
    ...partial,
  };
}

const step = {
  id: "call",
  action: "request",
  method: "POST",
  path: "/api/users/{{userId}}?run={{runId}}",
  headers: { authorization: "Bearer {{env.v7Token}}" },
  body: { email: "a-{{runId}}@example.com", note: "{{userId}}" },
  form: undefined,
} satisfies TestStep;

test("renders runId, variables, and env in path, headers, and body", () => {
  const secrets: string[] = [];
  const rendered = renderRequestStep(step, ctx({ secrets }));
  assert.equal(rendered.path, "/api/users/user-1?run=run-1");
  assert.equal(rendered.headers?.authorization, "Bearer sekret-value");
  assert.deepEqual(rendered.body, { email: "a-run-1@example.com", note: "user-1" });
  assert.deepEqual(secrets, ["sekret-value"]);
});

test("renders form fields", () => {
  const rendered = renderRequestStep(
    { ...step, body: undefined, form: { email: "a-{{runId}}@example.com" } },
    ctx(),
  );
  assert.deepEqual(rendered.form, { email: "a-run-1@example.com" });
});

test("missing variable fails without using a resolved env value", () => {
  const secrets: string[] = [];
  assert.throws(
    () =>
      renderRequestStep(
        { ...step, path: "/api/{{missing}}", headers: { authorization: "Bearer {{env.v7Token}}" } },
        ctx({ secrets }),
      ),
    /request missing variable: missing/,
  );
  const error = (() => {
    try {
      renderRequestStep(
        { ...step, headers: { authorization: "Bearer {{env.v7Token}}", "x-id": "{{missing}}" } },
        ctx({ secrets }),
      );
      return "";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  })();
  assert.match(error, /missing variable: missing/);
  assert.equal(error.includes("sekret-value"), false);
  assert.equal(redactSecretValues(`sent sekret-value`, secrets).includes("sekret-value"), false);
});

test("missing env fails and names the logical key and process env var", () => {
  assert.throws(
    () => renderRequestStep({ ...step, headers: { authorization: "{{env.notSet}}" } }, ctx()),
    /request missing env: notSet \(TESTPILOT_ENV_NOTSET\)/,
  );
});

test("lookupProcessEnv reads TESTPILOT_ENV_* and treats empty as missing", () => {
  process.env.TESTPILOT_ENV_V7UNIT = "present";
  process.env.TESTPILOT_ENV_V7EMPTY = "";
  try {
    assert.deepEqual(lookupProcessEnv("v7Unit"), { name: "TESTPILOT_ENV_V7UNIT", value: "present" });
    assert.deepEqual(lookupProcessEnv("v7Empty"), { name: "TESTPILOT_ENV_V7EMPTY", value: undefined });
    assert.equal(lookupProcessEnv("v7Absent").value, undefined);
  } finally {
    delete process.env.TESTPILOT_ENV_V7UNIT;
    delete process.env.TESTPILOT_ENV_V7EMPTY;
  }
});

test("saveAs stores the body and saveFields reads a dot path", () => {
  const vars: Record<string, string> = {};
  assignResponseVariables(
    { ...step, saveAs: "raw", saveFields: { userId: "user.id", tag: "tags.0" } },
    JSON.stringify({ user: { id: "user-9" }, tags: ["alpha"] }),
    vars,
  );
  assert.equal(vars.userId, "user-9");
  assert.equal(vars.tag, "alpha");
  assert.match(vars.raw ?? "", /user-9/);
});

test("saveFields fails when the response is not JSON or the path is missing", () => {
  assert.throws(
    () => assignResponseVariables({ ...step, saveFields: { userId: "id" } }, "not-json", {}),
    /response is not JSON/,
  );
  assert.throws(
    () => assignResponseVariables({ ...step, saveFields: { userId: "id" } }, "{}", {}),
    /saveFields missing path: id/,
  );
});

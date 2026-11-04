import assert from "node:assert/strict";
import test from "node:test";
import { runCapturedHttpAssertion, validateCapturedHttpAssertion } from "./captured-http.js";

const page = {} as import("playwright").Page;
const resolveRef = () => ({ urlIncludes: "/api/users", method: "POST" });

const baseNetwork = [
  {
    url: "http://127.0.0.1:4173/api/users",
    method: "POST",
    status: 201,
    resourceType: "fetch",
    requestBody: JSON.stringify({ email: "new@example.com" }),
    responseBody: JSON.stringify({ id: "u1", status: "ok" }),
    responseHeaders: { "content-type": "application/json; charset=utf-8" },
  },
];

test("captured-http: statusCode + request jsonBody (legacy)", async () => {
  const outcome = await runCapturedHttpAssertion(
    {
      id: "dup",
      type: "api",
      requestRef: "users-create",
      expect: { statusCode: 409, jsonBody: { email: "duplicate@example.com" } },
      oracle: "api-contract",
    },
    {
      page,
      network: [
        {
          url: "http://127.0.0.1/api/users",
          method: "POST",
          status: 409,
          requestBody: JSON.stringify({ email: "duplicate@example.com" }),
        },
      ],
      resolveRequestRef: resolveRef,
    },
  );
  assert.equal(outcome.passed, true);
});

test("captured-http: responseJsonBody and responseHeaders pass", async () => {
  const outcome = await runCapturedHttpAssertion(
    {
      id: "created",
      type: "api",
      requestRef: "users-create",
      expect: {
        statusCode: 201,
        responseJsonBody: { id: "u1", status: "ok" },
        responseHeaders: { "content-type": "application/json" },
      },
      oracle: "api-contract",
    },
    { page, network: baseNetwork, resolveRequestRef: resolveRef },
  );
  assert.equal(outcome.passed, true);
});

test("captured-http: responseJsonSchema pass and fail", async () => {
  const pass = await runCapturedHttpAssertion(
    {
      id: "schema-ok",
      type: "api",
      requestRef: "users-create",
      expect: {
        statusCode: 201,
        responseJsonSchema: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" }, status: { type: "string" } },
        },
      },
      oracle: "api-contract",
    },
    { page, network: baseNetwork, resolveRequestRef: resolveRef },
  );
  assert.equal(pass.passed, true);

  const fail = await runCapturedHttpAssertion(
    {
      id: "schema-bad",
      type: "api",
      requestRef: "users-create",
      expect: {
        statusCode: 201,
        responseJsonSchema: { type: "object", required: ["missing"] },
      },
      oracle: "api-contract",
    },
    { page, network: baseNetwork, resolveRequestRef: resolveRef },
  );
  assert.equal(fail.passed, false);
  assert.equal(fail.errorKind, "PRODUCT_DEFECT");
});

test("captured-http: wrong status fails (negative)", async () => {
  const outcome = await runCapturedHttpAssertion(
    {
      id: "status",
      type: "api",
      requestRef: "users-create",
      expect: { statusCode: 500 },
      oracle: "api-contract",
    },
    { page, network: baseNetwork, resolveRequestRef: resolveRef },
  );
  assert.equal(outcome.passed, false);
});

test("captured-http: responseBodyContains negative", async () => {
  const outcome = await runCapturedHttpAssertion(
    {
      id: "body",
      type: "api",
      requestRef: "users-create",
      expect: { responseBodyContains: "NOT_IN_BODY" },
      oracle: "api-contract",
    },
    { page, network: baseNetwork, resolveRequestRef: resolveRef },
  );
  assert.equal(outcome.passed, false);
});

test("captured-http: empty expect with 500 response fails oracle (negative)", async () => {
  const outcome = await runCapturedHttpAssertion(
    {
      id: "empty-expect",
      type: "api",
      requestRef: "users-create",
      expect: {},
      oracle: "api-contract",
    },
    {
      page,
      network: [{ ...baseNetwork[0]!, status: 500 }],
      resolveRequestRef: resolveRef,
    },
  );
  assert.equal(outcome.passed, false);
  assert.equal(outcome.errorKind, "ASSERTION_ORACLE");
});

test("captured-http: responseJsonSchema minimum fails at runtime (negative)", async () => {
  const outcome = await runCapturedHttpAssertion(
    {
      id: "schema-min",
      type: "api",
      requestRef: "users-create",
      expect: {
        statusCode: 201,
        responseJsonSchema: { type: "integer", minimum: 10 },
      },
      oracle: "api-contract",
    },
    { page, network: baseNetwork, resolveRequestRef: resolveRef },
  );
  assert.equal(outcome.passed, false);
  assert.equal(outcome.errorKind, "PRODUCT_DEFECT");
});

test("validateCapturedHttpAssertion rejects unknown expect field (negative)", () => {
  const issues = validateCapturedHttpAssertion({
    id: "bad-field",
    type: "api",
    requestRef: "users-create",
    expect: { status: 200 },
    oracle: "human-approved",
  });
  assert.ok(issues.some((i) => i.path.includes("status")));
  assert.ok(issues.some((i) => i.message.includes("statusCode") || i.message.includes("不支持")));
});

test("validateCapturedHttpAssertion accepts a valid responseJsonSchema", () => {
  const issues = validateCapturedHttpAssertion({
    id: "valid-schema",
    type: "api",
    requestRef: "users-create",
    expect: {
      statusCode: 201,
      responseJsonSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    },
    oracle: "api-contract",
  });
  assert.deepEqual(issues, []);
});

test("validateCapturedHttpAssertion rejects no-op and unknown schema rules", () => {
  const emptySchema = validateCapturedHttpAssertion({
    id: "empty-schema",
    type: "api",
    requestRef: "users-create",
    expect: { responseJsonSchema: {} },
    oracle: "api-contract",
  });
  assert.ok(emptySchema.some((i) => i.path.includes("responseJsonSchema")));

  const emptyBody = validateCapturedHttpAssertion({
    id: "empty-body",
    type: "api",
    requestRef: "users-create",
    expect: { responseBodyContains: "" },
    oracle: "api-contract",
  });
  assert.ok(emptyBody.some((i) => i.path.includes("responseBodyContains")));

  const emptyHeaders = validateCapturedHttpAssertion({
    id: "empty-headers",
    type: "api",
    requestRef: "users-create",
    expect: { responseHeaders: {} },
    oracle: "api-contract",
  });
  assert.ok(emptyHeaders.some((i) => i.path.includes("responseHeaders")));

  const unknownKeyword = validateCapturedHttpAssertion({
    id: "unknown-keyword",
    type: "api",
    requestRef: "users-create",
    expect: { responseJsonSchema: { type: "integer", minimun: 10 } },
    oracle: "api-contract",
  });
  assert.ok(unknownKeyword.some((i) => i.path.includes("responseJsonSchema")));
});

test("captured-http: empty schema and empty contains fail as oracle (negative)", async () => {
  const network = [{ ...baseNetwork[0]!, status: 500 }];
  const emptySchema = await runCapturedHttpAssertion(
    {
      id: "empty-schema",
      type: "api",
      requestRef: "users-create",
      expect: { responseJsonSchema: {} },
      oracle: "api-contract",
    },
    { page, network, resolveRequestRef: resolveRef },
  );
  assert.equal(emptySchema.passed, false);
  assert.equal(emptySchema.errorKind, "ASSERTION_ORACLE");

  const emptyContains = await runCapturedHttpAssertion(
    {
      id: "empty-contains",
      type: "api",
      requestRef: "users-create",
      expect: { responseBodyContains: "" },
      oracle: "api-contract",
    },
    { page, network, resolveRequestRef: resolveRef },
  );
  assert.equal(emptyContains.passed, false);
  assert.equal(emptyContains.errorKind, "ASSERTION_ORACLE");
});

import assert from "node:assert/strict";
import test from "node:test";
import { runCapturedHttpAssertion } from "./captured-http.js";

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

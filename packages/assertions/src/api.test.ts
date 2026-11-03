import assert from "node:assert/strict";
import test from "node:test";
import { runApiAssertion } from "./index.js";

const network = [
  {
    url: "http://127.0.0.1:4173/api/users",
    method: "POST",
    status: 409,
    resourceType: "fetch",
  },
];

test("runApiAssertion matches statusCode on requestRef", async () => {
  const outcome = await runApiAssertion(
    {
      id: "dup",
      type: "api",
      requestRef: "users-create-attempt",
      expect: { statusCode: 409 },
      oracle: "api-contract",
    },
    {
      page: {} as import("playwright").Page,
      network,
      resolveRequestRef: (ref) =>
        ref === "users-create-attempt" ? { urlIncludes: "/api/users", method: "POST" } : undefined,
    },
  );
  assert.equal(outcome.passed, true);
});

test("runApiAssertion matches jsonBody on request payload", async () => {
  const outcome = await runApiAssertion(
    {
      id: "dup",
      type: "api",
      requestRef: "users-create-attempt",
      expect: { statusCode: 409, jsonBody: { email: "duplicate@example.com" } },
      oracle: "api-contract",
    },
    {
      page: {} as import("playwright").Page,
      network: [
        {
          url: "http://127.0.0.1:4173/api/users",
          method: "POST",
          status: 409,
          requestBody: JSON.stringify({ email: "duplicate@example.com" }),
        },
      ],
      resolveRequestRef: () => ({ urlIncludes: "/api/users", method: "POST" }),
    },
  );
  assert.equal(outcome.passed, true);
});

test("runApiAssertion userCountDelta 0 rejects 201", async () => {
  const outcome = await runApiAssertion(
    {
      id: "no-create",
      type: "api",
      requestRef: "users-lookup-existing-email",
      expect: { userCountDelta: 0 },
      oracle: "api-contract",
    },
    {
      page: {} as import("playwright").Page,
      network: [{ url: "http://x/api/users", method: "POST", status: 201 }],
      resolveRequestRef: () => ({ urlIncludes: "/api/users", method: "POST" }),
    },
  );
  assert.equal(outcome.passed, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { redactForEvidence, redactHeaders, redactStringBody, redactStrings, redactUrl } from "./redact.js";

test("redactStringBody covers JSON, urlencoded form, and plain text", () => {
  const json = '{"email":"user@example.com","phone":"13800138000"}';
  assert.doesNotMatch(redactStringBody(json), /user@example\.com/);

  const form = "phone=13800138000&email=u@example.com&count=3";
  const redactedForm = redactStringBody(form);
  assert.doesNotMatch(redactedForm, /13800138000/);
  assert.doesNotMatch(redactedForm, /u@example\.com/);
  assert.match(redactedForm, /count=3/);

  const plain = "contact 13800138000 or u@example.com";
  const redactedPlain = redactStringBody(plain);
  assert.doesNotMatch(redactedPlain, /13800138000/);
  assert.doesNotMatch(redactedPlain, /u@example\.com/);
});

test("redactHeaders masks set-cookie and authorization", () => {
  const headers = redactHeaders({
    "set-cookie": "session=abc",
    authorization: "Bearer secret",
    "content-type": "application/json",
  });
  assert.equal(headers?.["set-cookie"], "***");
  assert.equal(headers?.authorization, "***");
  assert.match(headers?.["content-type"] ?? "", /json/);
});

test("redactUrl masks sensitive query params", () => {
  const url = redactUrl("https://app.example.com/api?phone=13800138000&email=u@example.com&page=1");
  assert.doesNotMatch(url, /13800138000/);
  assert.doesNotMatch(url, /u@example\.com/);
  assert.match(url, /page=1/);
});

test("redactForEvidence applies header and body rules on nested actual", () => {
  const out = redactForEvidence({
    requestBodies: ["phone=13800138000&email=u@example.com"],
    responseHeaders: { "set-cookie": "sid=1" },
    url: "http://127.0.0.1/x?phone=13800138000",
  }) as Record<string, unknown>;
  assert.doesNotMatch(JSON.stringify(out), /13800138000/);
  assert.doesNotMatch(JSON.stringify(out), /u@example\.com/);
});

test("redactStrings preserves keys while redacting expect values", () => {
  const out = redactStrings({
    requestBodyContains: "13800138000",
    responseJsonSchema: {
      type: "object",
      properties: { email: { type: "string" } },
    },
  }) as Record<string, unknown>;
  assert.equal(out.requestBodyContains, "***");
  const schema = out.responseJsonSchema as {
    properties: { email: { type: string } };
  };
  assert.equal(schema.properties.email.type, "string");
});

test("redactForEvidence keeps numeric LLM usage counters", () => {
  const out = redactForEvidence({
    llmTokensUsed: 1234,
    accessToken: "secret-value",
    nested: { llmTokensUsed: 42 },
  }) as Record<string, unknown>;
  assert.equal(out.llmTokensUsed, 1234);
  assert.equal(out.accessToken, "***");
  assert.equal((out.nested as Record<string, unknown>).llmTokensUsed, 42);
});

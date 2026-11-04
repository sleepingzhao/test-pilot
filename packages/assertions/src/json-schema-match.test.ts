import assert from "node:assert/strict";
import test from "node:test";
import { matchesJsonSchema } from "./json-schema-match.js";

test("matchesJsonSchema validates required object fields", () => {
  const ok = matchesJsonSchema(
    { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    { id: "x" },
  );
  assert.equal(ok.ok, true);

  const bad = matchesJsonSchema(
    { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    {},
  );
  assert.equal(bad.ok, false);
});

test("matchesJsonSchema enforces minimum on integer (negative)", () => {
  const schema = { type: "integer", minimum: 10 };
  assert.equal(matchesJsonSchema(schema, 15).ok, true);
  const fail = matchesJsonSchema(schema, 1);
  assert.equal(fail.ok, false);
  assert.match(fail.message, /10/);
});

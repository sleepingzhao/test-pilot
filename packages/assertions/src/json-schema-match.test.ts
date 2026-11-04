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

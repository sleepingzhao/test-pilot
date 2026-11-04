import assert from "node:assert/strict";
import test from "node:test";
import { partialJsonMatch } from "./api-match.js";

test("partialJsonMatch checks nested request fields", () => {
  assert.equal(
    partialJsonMatch({ error: "duplicate", email: "duplicate@example.com" }, {
      error: "duplicate",
      email: "duplicate@example.com",
    }),
    true,
  );
  assert.equal(partialJsonMatch({ email: "other@x.com" }, { email: "duplicate@example.com" }), false);
});

test("partialJsonMatch rejects number vs string coercion (negative)", () => {
  assert.equal(partialJsonMatch({ count: 1 }, { count: "1" }), false);
  assert.equal(partialJsonMatch({ count: 1 }, { count: 1 }), true);
});

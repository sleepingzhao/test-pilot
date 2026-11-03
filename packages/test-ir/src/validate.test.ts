import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { validateSemantics, validateTestIR } from "./validate.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

test("accepts roadmap example IR", () => {
  const doc = JSON.parse(readFileSync(join(fixturesDir, "user-create-duplicate-email.json"), "utf8"));
  const result = validateTestIR(doc);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(validateSemantics(result.value), []);
  }
});

test("rejects step without required fields", () => {
  const result = validateTestIR({
    id: "bad",
    version: 1,
    platform: "web",
    steps: [{ id: "x", action: "click" }],
    assertions: [{ type: "ui", oracle: "human-approved", contains: "ok" }],
  });
  assert.equal(result.ok, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { redactStringBody } from "./redact.js";

test("assertions use raw capture; artifacts redact sensitive JSON keys", () => {
  const raw = '{"email":"user@example.com","phone":"13800138000"}';
  assert.match(raw, /@example\.com/);
  const redacted = redactStringBody(raw);
  assert.doesNotMatch(redacted, /user@example\.com/);
  assert.match(redacted, /"\*\*\*"/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { resolveRequirementTargetUrl } from "./requirement-target.js";

test("demo target resolves practice URL", () => {
  const r = resolveRequirementTargetUrl({
    target: "demo",
    demoUrl: "http://127.0.0.1:4173/",
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.url, "http://127.0.0.1:4173/");
});

test("pilot without config fails (negative)", () => {
  const r = resolveRequirementTargetUrl({
    target: "pilot",
    demoUrl: "http://127.0.0.1:4173/",
  });
  assert.equal(r.ok, false);
});

test("custom requires URL (negative)", () => {
  const r = resolveRequirementTargetUrl({
    target: "custom",
    demoUrl: "http://127.0.0.1:4173/",
  });
  assert.equal(r.ok, false);
});

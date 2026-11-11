import assert from "node:assert/strict";
import test from "node:test";
import { resolveRequestRef } from "./index.js";

test("resolveRequestRef maps files-upload to the demo upload endpoint", () => {
  const spec = resolveRequestRef("files-upload", { baseUrl: "http://127.0.0.1:4173" });
  assert.deepEqual(spec, { urlIncludes: "/api/files", method: "POST" });
});

test("resolveRequestRef lets the run environment override a default", () => {
  const spec = resolveRequestRef("files-upload", {
    baseUrl: "http://127.0.0.1:4173",
    requestRefs: { "files-upload": { urlIncludes: "/custom/upload", method: "PUT" } },
  });
  assert.deepEqual(spec, { urlIncludes: "/custom/upload", method: "PUT" });
});

test("resolveRequestRef returns undefined for an unknown ref", () => {
  assert.equal(resolveRequestRef("missing-ref", { baseUrl: "http://127.0.0.1:4173" }), undefined);
});

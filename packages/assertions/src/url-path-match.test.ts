import assert from "node:assert/strict";
import test from "node:test";
import { urlPathMatches } from "./url-path-match.js";

test("urlPathMatches exact path only (negative export path)", () => {
  assert.equal(urlPathMatches("http://127.0.0.1/api/users", "/api/users"), true);
  assert.equal(urlPathMatches("http://127.0.0.1/api/users/export", "/api/users"), false);
});

test("pilot workorder create needs the full API path", () => {
  const url = "http://150.158.83.127:8080/api/workorder/workOrder/create";
  assert.equal(urlPathMatches(url, "/workorder/"), false);
  assert.equal(urlPathMatches(url, "/api/workorder/workOrder/create"), true);
});

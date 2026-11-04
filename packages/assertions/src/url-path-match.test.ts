import assert from "node:assert/strict";
import test from "node:test";
import { urlPathMatches } from "./url-path-match.js";

test("urlPathMatches exact path only (negative export path)", () => {
  assert.equal(urlPathMatches("http://127.0.0.1/api/users", "/api/users"), true);
  assert.equal(urlPathMatches("http://127.0.0.1/api/users/export", "/api/users"), false);
});

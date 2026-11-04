import assert from "node:assert/strict";
import { resolveValueRefEnvKey, resolveValueRefs } from "./dist/index.js";

assert.equal(resolveValueRefEnvKey("env.adminPhone"), "TESTPILOT_ENV_ADMIN_PHONE");
assert.equal(resolveValueRefEnvKey("env.adminPassword"), "TESTPILOT_ENV_ADMIN_PASSWORD");

process.env.TESTPILOT_ENV_ADMIN_PHONE = "13800138000";
process.env.TESTPILOT_ENV_ADMIN_PASSWORD = "secret";
const ir = {
  id: "x",
  version: 1,
  platform: "web",
  steps: [
    { id: "a", action: "fill", target: { label: "手机号" }, valueRef: "env.adminPhone" },
    { id: "b", action: "fill", target: { label: "密码" }, valueRef: "env.adminPassword" },
  ],
  assertions: [],
};

const refs = resolveValueRefs(ir, { baseUrl: "http://127.0.0.1:4173" });
assert.equal(refs["env.adminPhone"], "13800138000");
assert.equal(refs["env.adminPassword"], "secret");

console.log("fixtures value-ref tests ok");

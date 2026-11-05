import assert from "node:assert/strict";
import test from "node:test";
import {
  isPilotIntakeUrl,
  looksLikeLoginPageContext,
  resolvePilotTargetPath,
} from "./pilot-intake-snapshot.js";

test("isPilotIntakeUrl matches pilot origin only", () => {
  assert.equal(isPilotIntakeUrl("https://pilot.example/customer", "https://pilot.example"), true);
  assert.equal(isPilotIntakeUrl("http://127.0.0.1:4173/", "https://pilot.example"), false);
});

test("resolvePilotTargetPath keeps pathname on same origin", () => {
  assert.equal(
    resolvePilotTargetPath("https://pilot.example/customer?x=1", "https://pilot.example"),
    "/customer?x=1",
  );
});

test("looksLikeLoginPageContext detects admin login URL", () => {
  assert.equal(
    looksLikeLoginPageContext({
      url: "https://pilot.example/admin/login",
      elements: [{ role: "button", name: "登录" }],
    }),
    true,
  );
});

test("looksLikeLoginPageContext accepts customer home", () => {
  assert.equal(
    looksLikeLoginPageContext({
      url: "https://pilot.example/customer",
      elements: [{ role: "button", name: "选择服务项目" }],
    }),
    false,
  );
});

test("looksLikeLoginPageContext detects login form without app shell", () => {
  assert.equal(
    looksLikeLoginPageContext({
      url: "https://pilot.example/admin/login",
      elements: [
        { role: "textbox", name: "手机号" },
        { role: "textbox", name: "请输入密码" },
        { role: "button", name: "登录" },
      ],
    }),
    true,
  );
});

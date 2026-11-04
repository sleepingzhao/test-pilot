import assert from "node:assert/strict";
import test from "node:test";
import { isWeakAssertionText } from "@testpilot/test-ir";
import { planFromIntake, suggestAssertionHints } from "./intake.js";
import type { PageContext } from "./types.js";

/** Snapshot shape after opening the ticket form on demo-webapp (design §5 testId-first). */
const demoTicketFormContext: PageContext = {
  url: "http://127.0.0.1:4173/",
  elements: [
    { role: "button", name: "提交工单", testId: "open-ticket" },
    { role: "input", name: "标题", testId: "ticket-title", inputType: "text" },
    { role: "textarea", name: "描述", testId: "ticket-body" },
    { role: "input", name: "附件（练习环境不测试上传）", inputType: "file" },
    { role: "button", name: "提交", testId: "submit-ticket" },
    { role: "button", name: "取消" },
    { role: "alert", testId: "ticket-alert" },
  ],
};

const demoCustomerContext: PageContext = {
  url: "http://127.0.0.1:4173/customer",
  elements: [
    { role: "heading", name: "客户中心" },
    { role: "button", name: "选择服务项目" },
  ],
};

test("negated ticket intent stays a page smoke", () => {
  const draft = planFromIntake({
    title: "客户中心页加载",
    channel: "intent",
    text: "登录后打开客户中心页，确认页面正常加载，不要求提交工单。",
    context: demoCustomerContext,
  });
  assert.ok(!draft.steps.some((s) => s.id === "open-submit-ticket"));
  assert.ok(draft.assertions.some((a) => a.id === "page-loaded"));
});

test("assertion suggestions pass the approval strength gate", () => {
  for (const title of ["提交工单", "客户中心", "随便看看"]) {
    const hints = suggestAssertionHints(title, [], "");
    assert.ok(hints.suggestions.length > 0);
    for (const suggestion of hints.suggestions) {
      assert.equal(isWeakAssertionText(suggestion), false, suggestion);
    }
  }
});

test("ticket intake clicks form submit by testId, not 提交工单", () => {
  const draft = planFromIntake({
    title: "提交工单（无附件）",
    channel: "intent",
    text: "登录后提交工单，只填必填项，不要上传附件",
    context: demoTicketFormContext,
    constraints: ["不要测试附件上传"],
  });

  const openStep = draft.steps.find((s) => s.id === "open-submit-ticket");
  assert.ok(openStep?.target?.testId === "open-ticket" || openStep?.target?.name === "提交工单");

  const submitStep = draft.steps.find((s) => s.id === "submit-ticket-form");
  assert.equal(submitStep?.target?.testId, "submit-ticket");

  const waitStep = draft.steps.find((s) => s.id === "wait-after-submit");
  assert.equal(waitStep?.target?.testId, "ticket-alert");

  const successAssert = draft.assertions.find((a) => a.id === "ticket-submitted");
  assert.ok(successAssert?.contains?.includes("工单已提交"));
});

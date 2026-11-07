import { isWeakAssertionText, type TestAssertion, type TestStep } from "@testpilot/test-ir";
import type { FormHint, PageContext, PlannerDraft } from "./types.js";

export type IntakeChannel = "intent" | "prd" | "record";

export type IntakeInput = {
  title: string;
  channel: IntakeChannel;
  /** User goal in one paragraph, or pasted PRD excerpt */
  text: string;
  context: PageContext;
  constraints?: string[];
};

function norm(s: string): string {
  return s.toLowerCase();
}

function textNegatesTicket(text: string): boolean {
  return /(?:不|无需|不用|别|不要)(?:要|需|需要|要求)?(?:提交|测|测试|做|提)?(?:工单|ticket)/i.test(text);
}

function textMentionsTicket(text: string): boolean {
  if (textNegatesTicket(text)) return false;
  return /工单|ticket|提交需求/.test(text);
}

function textMentionsPageSmoke(text: string): boolean {
  return /页面加载|正常加载|能打开|客户中心|customer|首页/.test(text) && !textMentionsTicket(text);
}

function textMentionsNoAttachment(text: string, constraints?: string[]): boolean {
  const blob = [text, ...(constraints ?? [])].join(" ");
  return /不要.*附件|不带附件|无附件|忽略附件|不测附件|不上传/.test(blob);
}

function isAttachmentField(el: { name?: string; inputType?: string; role?: string }): boolean {
  const name = (el.name ?? "").toLowerCase();
  if (el.inputType === "file") return true;
  return /附件|上传|upload|file/.test(name);
}

function valueForField(label: string): string {
  if (/电话|手机|phone|mobile/i.test(label)) return "19900000000";
  if (/邮箱|email/i.test(label)) return "testpilot@example.com";
  if (/需求|描述|说明|备注|内容|标题/i.test(label)) return "TestPilot 自动化验证 {{runId}}";
  return "TestPilot-{{runId}}";
}

/** Plan from a form captured after opening it: the fields only exist inside the dialog. */
function appendExploredFormSteps(
  steps: TestStep[],
  form: FormHint,
  uncertainties: string[],
): void {
  const fields = form.fields ?? [];
  const filled: string[] = [];
  const chosen: string[] = [];
  fields.forEach((field, i) => {
    if (field.kind === "combobox") {
      if (!field.option) return;
      steps.push({
        id: `choose-${i + 1}`,
        action: "click",
        target: { label: field.label },
      });
      steps.push({
        id: `choose-${i + 1}-option`,
        action: "click",
        target: { role: "option", name: field.option },
      });
      chosen.push(`${field.label}=${field.option}`);
      return;
    }
    if (field.value?.trim()) return;
    steps.push({
      id: `fill-${i + 1}`,
      action: "fill",
      target: { label: field.label },
      value: valueForField(field.label),
    });
    filled.push(field.label);
  });
  if (form.submitLabel) {
    steps.push({
      id: "submit-form",
      action: "click",
      target: { role: "button", name: form.submitLabel },
    });
  }
  const parts = [
    filled.length ? `填写 ${filled.join("、")}` : "",
    chosen.length ? `选择 ${chosen.join("、")}` : "",
  ].filter(Boolean);
  uncertainties.push(
    `已从「${form.title ?? "打开的表单"}」识别表单：${parts.join("；") || "无需输入"}；下拉选项取自打开表单时看到的第一个可选项，试跑会验证整条链。`,
  );
}

/** Form submit — not nav actions like「提交工单」(design §5: prefer testId, avoid substring role names). */
function findFormSubmitButton(context: PageContext) {
  const buttons = context.elements.filter((el) => el.role === "button" && el.name?.trim());
  const exact = buttons.find((el) => /^(提交|确定|保存|创建)$/.test(el.name!.trim()));
  if (exact) return exact;
  return buttons.find(
    (el) =>
      /^(提交|确定|保存|创建)/.test(el.name!.trim()) &&
      !/工单|取消|关闭|上传/.test(el.name!),
  );
}

function appendTicketFormSteps(
  steps: TestStep[],
  context: PageContext,
  uncertainties: string[],
  skipAttachment: boolean,
): void {
  const fillables = context.elements.filter(
    (el) =>
      !isAttachmentField(el) &&
      (el.role === "textbox" ||
        el.role === "textarea" ||
        el.role === "input" ||
        el.inputType === "text" ||
        el.inputType === "email" ||
        el.inputType === "tel"),
  );
  let filled = 0;
  for (const el of fillables.slice(0, 6)) {
    const label = el.name?.trim();
    if (!label || label.length > 40) continue;
    if (/搜索|search/.test(label)) continue;
    steps.push({
      id: `fill-${filled + 1}`,
      action: "fill",
      target: el.testId ? { testId: el.testId } : { label },
      value: `TestPilot-{{runId}}`,
    });
    filled += 1;
  }
  if (filled > 0) {
    uncertainties.push(`已根据快照自动添加 ${filled} 个填写步骤（不含附件字段）；批准前请在真实页试跑确认。`);
  } else {
    uncertainties.push("未识别到可填写的文本字段；若表单在弹层内，请再跑一次 bootstrap 或录制补步。");
  }

  const submitBtn = findFormSubmitButton(context);
  if (submitBtn?.name) {
    steps.push({
      id: "submit-ticket-form",
      action: "click",
      target: submitBtn.testId
        ? { testId: submitBtn.testId }
        : { role: "button", name: submitBtn.name.trim() },
    });
    const alert = context.elements.find((el) => el.testId === "ticket-alert" || el.role === "alert");
    steps.push({
      id: "wait-after-submit",
      action: "wait",
      ...(alert?.testId ? { target: { testId: alert.testId } } : {}),
    });
  }

  if (skipAttachment) {
    uncertainties.push("已跳过 input[type=file] 与名称含「附件/上传」的字段。");
  }
}

export function planFromIntake(input: IntakeInput): PlannerDraft {
  const uncertainties: string[] = [
    "由规则引擎根据描述 + 页面快照生成草案，批准前请核对步骤与断言。",
  ];
  const sources = [input.channel, "page-context-snapshot"];
  if (input.constraints?.length) sources.push("pilot-constraints");

  const goal = input.text.trim() || input.title;
  const steps: TestStep[] = [
    {
      id: "open-target",
      action: "navigate",
      path: new URL(input.context.url).pathname || "/",
    },
  ];

  const combined = norm(goal);
  const ticketFlow = textMentionsTicket(goal) || textMentionsTicket(input.title);
  const form = input.context.form;
  const exploredForm = form && form.fields.length > 0 && form.submitLabel ? form : undefined;

  const submitTicketBtn = input.context.elements.find(
    (el) => el.role === "button" && el.name && /提交工单/.test(el.name),
  );
  if (ticketFlow) {
    const opener = submitTicketBtn?.name
      ? {
          id: "open-submit-ticket",
          action: "click" as const,
          target: submitTicketBtn.testId
            ? { testId: submitTicketBtn.testId }
            : { role: "button", name: submitTicketBtn.name.trim() },
        }
      : form?.scope === "dialog" && form.openTarget
        ? {
            id: "open-submit-ticket",
            action: "click" as const,
            target: { ...form.openTarget },
          }
        : undefined;
    if (opener) steps.push(opener);
    if (exploredForm) {
      appendExploredFormSteps(steps, exploredForm, uncertainties);
    } else {
      appendTicketFormSteps(
        steps,
        input.context,
        uncertainties,
        textMentionsNoAttachment(goal, input.constraints),
      );
    }
  }

  const assertions: TestAssertion[] = [];
  if (textMentionsNoAttachment(goal, input.constraints)) {
    uncertainties.push("试点约束：不要测试附件上传；断言中也不要出现「附件」相关文案。");
  }

  if (ticketFlow) {
    const alert = input.context.elements.find((el) => el.testId === "ticket-alert" || el.role === "alert");
    assertions.push({
      id: "ticket-submitted",
      type: "ui",
      ...(alert?.testId ? { target: { testId: alert.testId } } : {}),
      contains: "工单已提交",
      oracle: "human-approved",
    });
    uncertainties.push(
      textMentionsNoAttachment(goal, input.constraints)
        ? "断言示例为「工单已提交」；若试点文案不同，试跑会用页面上实际出现的成功提示替换。"
        : "成功提示按常见文案「工单已提交」生成；试跑会用页面上实际出现的成功提示校验或替换。",
    );
  } else if (textMentionsPageSmoke(goal) || textMentionsPageSmoke(input.title)) {
    const anchor = input.context.elements.find(
      (el) => el.name && /客户|工作台|首页|控制台|欢迎/.test(el.name) && el.name.length <= 32,
    );
    assertions.push({
      id: "page-loaded",
      type: "ui",
      contains: anchor?.name?.trim().slice(0, 24) || "客户",
      oracle: "human-approved",
    });
    uncertainties.push("页面 smoke：断言文案来自快照；批准前请改成页面上最稳定的标题或菜单名。");
  } else if (combined.includes("登录")) {
    assertions.push({
      id: "after-login",
      type: "ui",
      contains: "工单",
      oracle: "human-approved",
    });
  } else {
    const anchor = input.context.elements.find(
      (el) =>
        el.name &&
        el.name.length <= 32 &&
        /用户|列表|管理|首页|工作台|控制台|订单|客户/.test(el.name),
    );
    if (anchor?.name) {
      assertions.push({
        id: "page-loaded",
        type: "ui",
        ...(anchor.testId ? { target: { testId: anchor.testId } } : {}),
        contains: anchor.name.trim().slice(0, 24),
        oracle: "human-approved",
      });
      uncertainties.push("未匹配专用模板：先断言页面加载；成功提示请在审阅时补充或采纳 LLM 建议。");
    } else {
      uncertainties.push("未匹配专用模板：快照中没有稳定页面文案，请审阅时补充断言。");
    }
  }

  if (input.channel === "prd") {
    uncertainties.push("PRD 仅截取前若干段参与规划；完整需求请分条拆成多个用例。");
  }

  return { steps, assertions, uncertainties, sources };
}

export function suggestAssertionHints(
  title: string,
  steps: TestStep[],
  intentSummary?: string,
): { suggestions: string[]; help: string; uncertainties: string[] } {
  const uncertainties: string[] = [];
  const suggestions: string[] = [];
  const blob = `${title}\n${intentSummary ?? ""}`;
  const lastClick = [...steps].reverse().find((s) => s.action === "click");

  let help: string;
  if (textMentionsTicket(blob)) {
    help =
      "断言写「操作成功后页面上一定能看到的文字」，例如成功提示、列表标题。不要写附件、上传文件名。";
    suggestions.push("工单", "提交成功", "已提交", "我的工单");
    if (textMentionsNoAttachment(blob)) {
      uncertainties.push("约束：不测附件；请勿选择含「附件」的断言。");
    }
  } else if (lastClick?.target?.name) {
    help = `上一步点击了「${lastClick.target.name}」。断言应描述点击后页面出现的稳定文案（按钮名、标题、提示语均可）。`;
    suggestions.push(lastClick.target.name, "保存成功", "操作成功");
  } else {
    help =
      "在「页面应包含」里填一段成功后的可见文字（8～30 字），不要填步骤说明。可先点下方建议，再微调。";
    suggestions.push("登录", "管理", "成功");
  }

  const strong = suggestions.filter((text) => !isWeakAssertionText(text));
  if (strong.length === 0) strong.push("操作成功", "保存成功", "提交成功");
  return { suggestions: [...new Set(strong)], help, uncertainties };
}

export function filterForbiddenSuggestionTokens(suggestions: string[], forbidden: string[]): string[] {
  if (!forbidden.length) return suggestions;
  return suggestions.filter((s) => {
    const lower = s.toLowerCase();
    return !forbidden.some((token) => {
      const t = token.trim();
      return t && lower.includes(t.toLowerCase());
    });
  });
}

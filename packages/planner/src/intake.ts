import type { TestAssertion, TestStep } from "@testpilot/test-ir";
import type { PageContext, PlannerDraft } from "./types.js";

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

function textMentionsTicket(text: string): boolean {
  return /工单|ticket|提交需求/.test(text);
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

  const submitBtn = context.elements.find(
    (el) =>
      el.role === "button" &&
      el.name &&
      /^(提交|确定|保存|创建)/.test(el.name) &&
      !/取消|关闭/.test(el.name),
  );
  if (submitBtn?.name) {
    steps.push({
      id: "submit-ticket-form",
      action: "click",
      target: submitBtn.testId
        ? { testId: submitBtn.testId }
        : { role: "button", name: submitBtn.name },
    });
    steps.push({ id: "wait-after-submit", action: "wait" });
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

  const submitTicketBtn = input.context.elements.find(
    (el) => el.role === "button" && el.name && /提交工单/.test(el.name),
  );
  if (ticketFlow && submitTicketBtn?.name) {
    steps.push({
      id: "open-submit-ticket",
      action: "click",
      target: { role: "button", name: submitTicketBtn.name },
    });
    appendTicketFormSteps(
      steps,
      input.context,
      uncertainties,
      textMentionsNoAttachment(goal, input.constraints),
    );
  }

  const assertions: TestAssertion[] = [];
  if (textMentionsNoAttachment(goal, input.constraints)) {
    uncertainties.push("试点约束：不要测试附件上传；断言中也不要出现「附件」相关文案。");
  }

  if (ticketFlow) {
    assertions.push({
      id: "ticket-context",
      type: "ui",
      contains: "工单",
      oracle: "human-approved",
    });
    if (textMentionsNoAttachment(goal, input.constraints)) {
      assertions.push({
        id: "submit-without-attachment",
        type: "ui",
        contains: "提交",
        oracle: "human-approved",
      });
    }
  } else if (combined.includes("登录")) {
    assertions.push({
      id: "after-login",
      type: "ui",
      contains: "工单",
      oracle: "human-approved",
    });
  } else {
    const snippet = goal.slice(0, 24).replace(/\s+/g, "");
    assertions.push({
      id: "goal-smoke",
      type: "ui",
      contains: snippet.length >= 4 ? goal.slice(0, 24) : "管理控制台",
      oracle: "requirement",
    });
    uncertainties.push("未能匹配专用模板，请改用最显眼的成功提示文案作为断言。");
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

  return { suggestions: [...new Set(suggestions)], help, uncertainties };
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

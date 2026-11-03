import type { TestIR, TestStep, TestAssertion } from "@testpilot/test-ir";

export type PageContext = {
  url: string;
  /** Trimmed accessibility-oriented element summaries */
  elements: Array<{ role?: string; name?: string; testId?: string }>;
};

export type PlannerDraft = {
  steps: TestStep[];
  assertions: TestAssertion[];
  uncertainties: string[];
  sources: string[];
};

export type PlannerInput = {
  goal: string;
  context: PageContext;
};

/**
 * P0-5 stub: deterministic placeholder until LLM provider is wired.
 * Real planner will call LLM with trimmed DOM/ARIA only.
 */
export function planDraft(input: PlannerInput): PlannerDraft {
  const uncertainties = [
    "Planner 规则草案 — 接入 LLM 前请人工审阅全部步骤与断言。",
  ];
  if (input.context.elements.length === 0) {
    uncertainties.push("No interactive elements in context snapshot.");
  }

  const steps: TestStep[] = [
    { id: "explore-navigate", action: "navigate", path: new URL(input.context.url).pathname || "/" },
  ];

  const goal = input.goal.toLowerCase();
  const clickEl = input.context.elements.find(
    (el) =>
      el.role === "button" &&
      el.name &&
      (goal.includes("添加") || goal.includes("add")) &&
      (el.name.includes("添加") || el.name.toLowerCase().includes("add")),
  );
  if (clickEl?.testId) {
    steps.push({
      id: "planner-click-primary",
      action: "click",
      target: { testId: clickEl.testId, role: "button", name: clickEl.name },
    });
  } else if (clickEl?.name) {
    steps.push({
      id: "planner-click-primary",
      action: "click",
      target: { role: "button", name: clickEl.name },
    });
  }

  const assertions: TestAssertion[] = [
    {
      id: "goal-smoke",
      type: "ui",
      contains: input.goal.slice(0, 40),
      oracle: "requirement",
    },
  ];

  if (steps.length > 1) {
    assertions.push({
      id: "post-action-visible",
      type: "ui",
      contains: "邮箱",
      oracle: "human-approved",
    });
    uncertainties.push("已根据页面快照添加「邮箱」字段可见性断言，请确认是否符合目标。");
  }

  return {
    steps,
    assertions,
    uncertainties,
    sources: ["goal", "page-context-snapshot"],
  };
}

export function suggestAssertionsForTest(title: string, ir: Pick<TestIR, "steps">): {
  assertions: TestAssertion[];
  uncertainties: string[];
} {
  const uncertainties: string[] = ["规则引擎建议 — 确认后标记为已批准"];
  const lastStep = ir.steps.at(-1);
  const assertions: TestAssertion[] = [];

  if (title.includes("重复") || title.includes("拒绝")) {
    assertions.push({
      id: "suggest-duplicate",
      type: "ui",
      contains: "邮箱已被使用",
      oracle: "human-approved",
    });
  } else if (title.includes("成功") || title.includes("创建")) {
    assertions.push({
      id: "suggest-created",
      type: "ui",
      contains: "用户已创建",
      oracle: "human-approved",
    });
  } else if (title.includes("空") || title.includes("校验")) {
    assertions.push({
      id: "suggest-validation",
      type: "ui",
      contains: "请输入邮箱",
      oracle: "human-approved",
    });
  } else if (lastStep?.action === "click" && lastStep.target?.name) {
    assertions.push({
      id: "suggest-after-action",
      type: "ui",
      contains: "用户管理",
      oracle: "requirement",
    });
  } else {
    assertions.push({
      id: "suggest-smoke",
      type: "ui",
      contains: "用户管理",
      oracle: "requirement",
    });
    uncertainties.push("未匹配专用模板，使用页面冒烟断言");
  }

  return { assertions, uncertainties };
}

export function draftToPartialIR(
  id: string,
  draft: PlannerDraft,
): Pick<TestIR, "id" | "version" | "platform" | "steps" | "assertions"> {
  return {
    id,
    version: 1,
    platform: "web",
    steps: draft.steps,
    assertions: draft.assertions,
  };
}

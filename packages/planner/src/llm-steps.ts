import type { TestStep } from "@testpilot/test-ir";
import type { PageContext } from "./types.js";

export type LlmStepDraft = {
  id?: string;
  action?: string;
  path?: string;
  target?: { testId?: string; role?: string; name?: string; label?: string };
  value?: string;
  valueRef?: string;
  cascaderPath?: string[];
};

const ALLOWED = new Set(["navigate", "click", "fill", "wait", "select", "selectCascader", "press"]);

function elMatches(
  el: PageContext["elements"][number],
  target: NonNullable<LlmStepDraft["target"]>,
): boolean {
  if (target.testId) return el.testId === target.testId;
  if (target.label?.trim()) return (el.name ?? "").trim() === target.label.trim();
  if (target.role && target.name) {
    return el.role === target.role && (el.name ?? "").trim() === target.name.trim();
  }
  return false;
}

function findElements(context: PageContext, target: NonNullable<LlmStepDraft["target"]>) {
  return context.elements.filter((el) => elMatches(el, target));
}

function checkTarget(
  context: PageContext,
  target: NonNullable<LlmStepDraft["target"]>,
  id: string,
  issues: string[],
  warnings: string[],
): "ok" | "reject" {
  const matches = findElements(context, target);
  if (target.testId) {
    if (!matches.length) {
      issues.push(`步骤 ${id}：testId 不在页面快照中（禁止编造 testId）`);
      return "reject";
    }
    return "ok";
  }
  if (matches.length > 1) {
    issues.push(`步骤 ${id}：选择器不唯一（${matches.length} 个匹配），请使用 testId`);
    return "reject";
  }
  if (!matches.length) {
    // Dialog/post-click elements are not in the initial snapshot; the trial run is the ground truth.
    warnings.push(`步骤 ${id}：目标未出现在初始快照，将由试跑校验`);
  }
  return "ok";
}

function matchedName(
  context: PageContext,
  target: NonNullable<LlmStepDraft["target"]>,
): string | undefined {
  return findElements(context, target)[0]?.name;
}

function isSecretTarget(
  target: NonNullable<LlmStepDraft["target"]>,
  elementName?: string,
): boolean {
  return /密码|password/i.test(
    [target.label, target.name, elementName].filter(Boolean).join(" "),
  );
}

export function validateLlmStepsAgainstContext(
  rawSteps: LlmStepDraft[] | undefined,
  context: PageContext,
): { ok: true; steps: TestStep[]; warnings: string[] } | { ok: false; issues: string[] } {
  if (!rawSteps?.length) return { ok: false, issues: ["LLM 未返回步骤"] };
  const issues: string[] = [];
  const warnings: string[] = [];
  const steps: TestStep[] = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const raw = rawSteps[i]!;
    const id = raw.id?.trim() || `llm-step-${i + 1}`;
    const action = raw.action?.trim();
    if (!action || !ALLOWED.has(action)) {
      issues.push(`步骤 ${id}：不支持的动作 ${action ?? "(空)"}`);
      continue;
    }
    if (action === "navigate") {
      const path = raw.path?.trim() ?? "";
      if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("://")) {
        issues.push(`步骤 ${id}：navigate 只能使用站内相对 path，禁止编造或跨站 URL`);
        continue;
      }
      steps.push({ id, action: "navigate", path });
      continue;
    }
    if (action === "press") {
      if (!raw.value?.trim()) {
        issues.push(`步骤 ${id}：press 需要 value 作为按键`);
        continue;
      }
      steps.push({ id, action: "press", key: raw.value.trim() } as TestStep);
      continue;
    }
    if (action === "wait") {
      if (raw.target) {
        if (checkTarget(context, raw.target, id, issues, warnings) === "reject") continue;
        steps.push({
          id,
          action: "wait",
          target: raw.target.testId
            ? { testId: raw.target.testId }
            : raw.target.label
              ? { label: raw.target.label }
              : { role: raw.target.role!, name: raw.target.name! },
        });
      } else {
        steps.push({ id, action: "wait" });
      }
      continue;
    }
    if (!raw.target) {
      issues.push(`步骤 ${id}：缺少 target`);
      continue;
    }
    const matched = matchedName(context, raw.target);
    if (checkTarget(context, raw.target, id, issues, warnings) === "reject") continue;
    const target = raw.target.testId
      ? { testId: raw.target.testId }
      : raw.target.label
        ? { label: raw.target.label }
        : { role: raw.target.role!, name: raw.target.name! };

    if (action === "selectCascader") {
      if (!raw.cascaderPath?.length) {
        issues.push(`步骤 ${id}：selectCascader 需要 cascaderPath`);
        continue;
      }
      steps.push({ id, action: "selectCascader", target, cascaderPath: raw.cascaderPath });
      continue;
    }
    if (action === "fill") {
      if (raw.valueRef) {
        if (!/^env\.[A-Za-z_][A-Za-z0-9_]*$/.test(raw.valueRef)) {
          issues.push(`步骤 ${id}：valueRef 只允许 env.* 引用`);
          continue;
        }
        steps.push({ id, action: "fill", target, valueRef: raw.valueRef });
      } else if (raw.value != null) {
        if (isSecretTarget(raw.target, matched)) {
          issues.push(`步骤 ${id}：密码/凭据字段必须使用 env.* 引用，不能写字面量`);
          continue;
        }
        steps.push({ id, action: "fill", target, value: raw.value });
      } else {
        issues.push(`步骤 ${id}：fill 需要 value 或 valueRef`);
        continue;
      }
      continue;
    }
    if (action === "click" || action === "select") {
      steps.push({
        id,
        action,
        target,
        ...(action === "select" && raw.value ? { value: raw.value } : {}),
      } as TestStep);
      continue;
    }
  }
  if (!steps.length) return { ok: false, issues };
  if (issues.length) return { ok: false, issues };
  return { ok: true, steps, warnings };
}

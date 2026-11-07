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

function findElement(context: PageContext, target: NonNullable<LlmStepDraft["target"]>) {
  return context.elements.find((el) => elMatches(el, target));
}

export function validateLlmStepsAgainstContext(
  rawSteps: LlmStepDraft[] | undefined,
  context: PageContext,
): { ok: true; steps: TestStep[] } | { ok: false; issues: string[] } {
  if (!rawSteps?.length) return { ok: false, issues: ["LLM 未返回步骤"] };
  const issues: string[] = [];
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
      if (!path.startsWith("/") || path.includes("://")) {
        issues.push(`步骤 ${id}：navigate 只能使用相对 path，禁止编造 URL`);
        continue;
      }
      steps.push({ id, action: "navigate", path });
      continue;
    }
    if (action === "wait") {
      if (raw.target) {
        const el = findElement(context, raw.target);
        if (!el) {
          issues.push(`步骤 ${id}：等待目标不在快照中`);
          continue;
        }
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
    const el = findElement(context, raw.target);
    if (!el) {
      issues.push(`步骤 ${id}：选择器不在页面快照中（禁止编造 testId）`);
      continue;
    }
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
        steps.push({ id, action: "fill", target, valueRef: raw.valueRef });
      } else if (raw.value != null) {
        steps.push({ id, action: "fill", target, value: raw.value });
      } else {
        issues.push(`步骤 ${id}：fill 需要 value 或 valueRef`);
        continue;
      }
      continue;
    }
    if (action === "click" || action === "select" || action === "press") {
      steps.push({
        id,
        action,
        target,
        ...(action === "press" && raw.value ? { key: raw.value } : {}),
        ...(action === "select" && raw.value ? { value: raw.value } : {}),
      } as TestStep);
      continue;
    }
  }
  if (!steps.length) return { ok: false, issues };
  if (issues.length) return { ok: false, issues };
  return { ok: true, steps };
}

import type { TestStep } from "./types.js";

export function moveStep(steps: TestStep[], index: number, delta: -1 | 1): TestStep[] {
  const next = index + delta;
  if (next < 0 || next >= steps.length) return steps;
  const copy = [...steps];
  const tmp = copy[index]!;
  copy[index] = copy[next]!;
  copy[next] = tmp;
  return copy;
}

export function removeStepAt(steps: TestStep[], index: number): TestStep[] {
  if (index < 0 || index >= steps.length) return steps;
  return steps.filter((_, i) => i !== index);
}

export function replaceStep(steps: TestStep[], index: number, step: TestStep): TestStep[] {
  if (index < 0 || index >= steps.length) return steps;
  const copy = [...steps];
  copy[index] = step;
  return copy;
}

export function parseStepJson(raw: string): { ok: true; step: TestStep } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw) as TestStep;
    if (!parsed || typeof parsed !== "object") return { ok: false, error: "步骤必须是 JSON 对象" };
    if (!parsed.id || typeof parsed.id !== "string") return { ok: false, error: "步骤需要字符串 id" };
    if (!parsed.action) return { ok: false, error: "步骤需要 action" };
    return { ok: true, step: parsed };
  } catch {
    return { ok: false, error: "JSON 无效" };
  }
}

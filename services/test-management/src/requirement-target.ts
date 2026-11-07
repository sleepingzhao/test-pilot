import { isWeakAssertionText, type TestStep } from "@testpilot/test-ir";

export type RequirementTarget = "demo" | "pilot" | "custom";

/** Pick a success text the page actually showed, when all steps passed but assertions missed. */
export function pickObservedSuccessSignal(run: {
  status: string;
  steps: Array<{ status: string }>;
  finalSignals?: string[];
}): string | undefined {
  if (run.status === "passed") return undefined;
  if (!run.steps.length || run.steps.some((s) => s.status !== "passed")) return undefined;
  return (run.finalSignals ?? []).find(
    (text) => text.length >= 2 && text.length <= 80 && !isWeakAssertionText(text),
  );
}

/** Pilot runs need the login steps before any requirement-generated step. */
export function mergeRequirementSteps(
  onPilot: boolean,
  loginSteps: TestStep[],
  draftSteps: TestStep[],
): TestStep[] {
  if (!onPilot) return draftSteps;
  return [...loginSteps.map((s) => ({ ...s, id: `login-${s.id}` })), ...draftSteps];
}

export function resolveRequirementTargetUrl(input: {
  target: RequirementTarget;
  customUrl?: string;
  demoUrl: string;
  pilotUrl?: string;
  pilotIntakeUrl?: string;
}): { ok: true; url: string; label: string } | { ok: false; error: string } {
  if (input.target === "demo") {
    return { ok: true, url: input.demoUrl, label: "练习环境" };
  }
  if (input.target === "pilot") {
    const url = input.pilotIntakeUrl || input.pilotUrl;
    if (!url) return { ok: false, error: "未配置试点地址（TESTPILOT_PILOT_BASE_URL）" };
    return { ok: true, url, label: "业务试点" };
  }
  const raw = input.customUrl?.trim();
  if (!raw) return { ok: false, error: "自定义环境需要填写 URL" };
  try {
    new URL(raw);
  } catch {
    return { ok: false, error: "URL 格式无效" };
  }
  return { ok: true, url: raw, label: "自定义" };
}

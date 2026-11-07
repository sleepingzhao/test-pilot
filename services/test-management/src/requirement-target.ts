export type RequirementTarget = "demo" | "pilot" | "custom";

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

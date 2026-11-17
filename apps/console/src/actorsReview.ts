import type { TestActor } from "@testpilot/test-ir";

const ACTOR_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function validateActorsJson(raw: unknown): { ok: true; actors: TestActor[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "actors 必须是 JSON 数组" };
  if (raw.length > 8) return { ok: false, error: "最多 8 个账号" };
  const ids = new Set<string>();
  const actors: TestActor[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `actors[${i}] 必须是对象` };
    }
    const a = entry as Record<string, unknown>;
    if (typeof a.id !== "string" || !a.id.trim()) {
      return { ok: false, error: `actors[${i}].id 必须是字符串` };
    }
    const id = a.id.trim();
    if (!ACTOR_ID_RE.test(id)) {
      return { ok: false, error: `actors[${i}].id 须为小写字母/数字/连字符，且以字母或数字开头` };
    }
    if (ids.has(id)) return { ok: false, error: `重复的 actor id: ${id}` };
    ids.add(id);
    if (a.baseUrl && a.baseUrlRef) {
      return { ok: false, error: `actors[${i}] 不能同时设置 baseUrl 与 baseUrlRef` };
    }
    if (a.loginSteps !== undefined && !Array.isArray(a.loginSteps)) {
      return { ok: false, error: `actors[${i}].loginSteps 必须是数组` };
    }
    const actor: TestActor = { id };
    if (Array.isArray(a.loginSteps)) actor.loginSteps = a.loginSteps as TestActor["loginSteps"];
    if (typeof a.baseUrl === "string" && a.baseUrl.trim()) actor.baseUrl = a.baseUrl.trim();
    if (typeof a.baseUrlRef === "string" && a.baseUrlRef.trim()) actor.baseUrlRef = a.baseUrlRef.trim();
    actors.push(actor);
  }
  return { ok: true, actors };
}

export function loginStepCount(actor: TestActor): number {
  return actor.loginSteps?.length ?? 0;
}

export function formatActorsSaveError(text: string, status: number): string {
  try {
    const body = JSON.parse(text) as {
      error?: string;
      message?: string;
      issues?: Array<{ message?: string; path?: string }>;
    };
    if (Array.isArray(body.issues) && body.issues.length > 0) {
      return body.issues.map((i) => i.message ?? i.path ?? "校验失败").join("；");
    }
    return (body.message ?? body.error ?? text) || `HTTP ${status}`;
  } catch {
    return text || `HTTP ${status}`;
  }
}
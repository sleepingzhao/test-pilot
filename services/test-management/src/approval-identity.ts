import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

const ACTOR_RE = /^[a-zA-Z0-9][a-zA-Z0-9@._-]{0,79}$/;

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function tokensEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function approvalToken(): string | undefined {
  const token = process.env.TESTPILOT_APPROVAL_TOKEN?.trim();
  return token || undefined;
}

export function allowedApprovalActors(): Set<string> | null {
  const raw = process.env.TESTPILOT_APPROVAL_ACTORS?.trim();
  if (!raw) return null;
  const set = new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  return set.size ? set : null;
}

export type ApprovalActorResult =
  | { ok: true; actor: string }
  | { ok: false; statusCode: number; error: string };

export function resolveApprovalActor(req: FastifyRequest): ApprovalActorResult {
  const requiredToken = approvalToken();
  if (requiredToken) {
    const given = headerValue(req.headers["x-testpilot-approval-token"])?.trim();
    if (!given || !tokensEqual(given, requiredToken)) {
      return { ok: false, statusCode: 401, error: "审批需要有效的 x-testpilot-approval-token" };
    }
  }

  const rawActor = headerValue(req.headers["x-testpilot-actor"])?.trim();
  const actor = rawActor || (requiredToken ? "" : "local");
  if (!actor) {
    return { ok: false, statusCode: 400, error: "审批需要 x-testpilot-actor" };
  }
  if (!ACTOR_RE.test(actor)) {
    return { ok: false, statusCode: 400, error: "审批人标识格式无效" };
  }
  if (requiredToken && actor === "local") {
    return { ok: false, statusCode: 400, error: "启用审批令牌时不能使用 local 身份" };
  }

  const allowList = allowedApprovalActors();
  if (allowList && !allowList.has(actor)) {
    return { ok: false, statusCode: 403, error: "审批人不在允许列表中" };
  }

  return { ok: true, actor };
}

export function approvalIdentityPublicInfo(): {
  approvalTokenRequired: boolean;
  approvalActors: string[] | null;
} {
  const allow = allowedApprovalActors();
  return {
    approvalTokenRequired: Boolean(approvalToken()),
    approvalActors: allow ? [...allow].sort() : null,
  };
}

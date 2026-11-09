import type { WsFrame } from "@testpilot/evidence";
import { redactStringBody, redactUrl } from "@testpilot/evidence";
import type { TestAssertion, ValidationIssue } from "@testpilot/test-ir";
import type { AssertionContext, AssertionOutcome } from "./types.js";

const WS_EXPECT_KEYS = new Set([
  "urlIncludes",
  "direction",
  "contains",
  "regex",
  "jsonPath",
  "equals",
  "minCount",
  "absent",
  "timeoutMs",
]);

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

type WsExpect = {
  urlIncludes?: string;
  direction?: "sent" | "received";
  contains?: string;
  regex?: string;
  jsonPath?: string;
  equals?: string | number | boolean;
  minCount?: number;
  absent?: true;
  timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readDotPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (!part || current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function validateWsAssertion(assertion: TestAssertion): ValidationIssue[] {
  if (assertion.type !== "event") return [];
  if (assertion.provider && assertion.provider !== "ws") return [];
  const expect = assertion.expect ?? {};
  if (!isRecord(expect)) {
    return [{ path: "expect", message: "ws expect 必须是对象" }];
  }
  return validateWsExpect(expect);
}

export function validateWsExpect(expect: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(expect)) {
    if (!WS_EXPECT_KEYS.has(key)) {
      issues.push({ path: `expect/${key}`, message: `ws expect 不支持字段 "${key}"` });
    }
  }

  if ("urlIncludes" in expect && (typeof expect.urlIncludes !== "string" || expect.urlIncludes.length === 0)) {
    issues.push({ path: "expect/urlIncludes", message: "urlIncludes 必须是非空字符串" });
  }
  if ("direction" in expect && expect.direction !== "sent" && expect.direction !== "received") {
    issues.push({ path: "expect/direction", message: "direction 必须是 sent 或 received" });
  }
  if ("contains" in expect && (typeof expect.contains !== "string" || expect.contains.length === 0)) {
    issues.push({ path: "expect/contains", message: "contains 必须是非空字符串" });
  }
  if ("regex" in expect) {
    if (typeof expect.regex !== "string" || expect.regex.length === 0) {
      issues.push({ path: "expect/regex", message: "regex 必须是非空字符串" });
    } else {
      try {
        new RegExp(expect.regex);
      } catch {
        issues.push({ path: "expect/regex", message: "regex 无效" });
      }
    }
  }
  if ("jsonPath" in expect && typeof expect.jsonPath !== "string") {
    issues.push({ path: "expect/jsonPath", message: "jsonPath 必须是字符串" });
  } else if ("jsonPath" in expect && expect.jsonPath === "") {
    issues.push({ path: "expect/jsonPath", message: "jsonPath 必须是非空字符串" });
  }
  if ("equals" in expect && !isEqualsValue(expect.equals)) {
    issues.push({ path: "expect/equals", message: "equals 必须是 string、number 或 boolean" });
  }
  if ("jsonPath" in expect && !("equals" in expect)) {
    issues.push({ path: "expect/equals", message: "jsonPath 需要同时指定 equals" });
  }
  if ("equals" in expect && !("jsonPath" in expect)) {
    issues.push({ path: "expect/jsonPath", message: "equals 需要同时指定 jsonPath" });
  }
  if ("minCount" in expect) {
    const count = expect.minCount;
    if (typeof count !== "number" || !Number.isInteger(count)) {
      issues.push({ path: "expect/minCount", message: "minCount 必须是整数" });
    } else if (count < 0) {
      issues.push({ path: "expect/minCount", message: "minCount 不能为负" });
    }
  }
  if ("absent" in expect && expect.absent !== true) {
    issues.push({ path: "expect/absent", message: "absent 只能为 true" });
  }
  if (expect.absent === true && "minCount" in expect) {
    issues.push({ path: "expect/minCount", message: "absent 与 minCount 不能同时使用" });
  }
  if ("timeoutMs" in expect) {
    const timeout = expect.timeoutMs;
    if (typeof timeout !== "number" || !Number.isFinite(timeout)) {
      issues.push({ path: "expect/timeoutMs", message: "timeoutMs 必须是数字" });
    } else if (timeout < 0) {
      issues.push({ path: "expect/timeoutMs", message: "timeoutMs 不能为负" });
    } else if (timeout > MAX_TIMEOUT_MS) {
      issues.push({ path: "expect/timeoutMs", message: "timeoutMs 不能超过 60000" });
    }
  }

  const hasCriterion = Object.keys(expect).some((key) => key !== "timeoutMs" && WS_EXPECT_KEYS.has(key));
  if (!hasCriterion) {
    issues.push({
      path: "expect",
      message: "ws 断言需要 urlIncludes、direction、contains、regex、jsonPath 与 equals、minCount 或 absent",
    });
  }
  return issues;
}

function isEqualsValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function frameFiltered(frame: WsFrame, expect: WsExpect): boolean {
  if (expect.urlIncludes && !frame.url.includes(expect.urlIncludes)) return false;
  if (expect.direction && frame.direction !== expect.direction) return false;
  return true;
}

function frameMatches(frame: WsFrame, expect: WsExpect): boolean {
  if (!frameFiltered(frame, expect)) return false;
  if (expect.contains !== undefined && !frame.payload.includes(expect.contains)) return false;
  if (expect.regex !== undefined && !new RegExp(expect.regex).test(frame.payload)) return false;
  if (expect.jsonPath !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.payload);
    } catch {
      return false;
    }
    if (readDotPath(parsed, expect.jsonPath) !== expect.equals) return false;
  }
  return true;
}

function summarizeFrames(frames: WsFrame[]): string {
  if (frames.length === 0) return "no websocket frames";
  const sample = frames.slice(0, 5).map((frame) => {
    const payload = redactStringBody(frame.payload).slice(0, 180);
    return `${frame.direction} ${redactUrl(frame.url)} ${payload}`;
  });
  const extra = frames.length > 5 ? ` (+${frames.length - 5} more)` : "";
  return `${frames.length} frame(s): ${sample.join(" | ")}${extra}`;
}

function defect(id: string, expect: WsExpect, message: string, frames: WsFrame[]): AssertionOutcome {
  return {
    assertionId: id,
    passed: false,
    errorKind: "PRODUCT_DEFECT",
    expected: expect,
    actual: summarizeFrames(frames),
    message: redactStringBody(message),
  };
}

export async function runWsAssertion(
  assertion: TestAssertion,
  ctx: AssertionContext,
): Promise<AssertionOutcome> {
  const id = assertion.id ?? "ws-assertion";
  if (assertion.type !== "event") {
    return {
      assertionId: id,
      passed: false,
      errorKind: "ASSERTION_ORACLE",
      message: `expected event assertion, got ${assertion.type}`,
    };
  }
  const raw = assertion.expect ?? {};
  if (!isRecord(raw)) {
    return {
      assertionId: id,
      passed: false,
      errorKind: "ASSERTION_ORACLE",
      message: "ws expect 必须是对象",
    };
  }
  const issues = validateWsExpect(raw);
  if (issues.length > 0) {
    return {
      assertionId: id,
      passed: false,
      errorKind: "ASSERTION_ORACLE",
      message: issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      expected: raw,
    };
  }

  const expect = raw as WsExpect;
  const timeoutMs = expect.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const minCount = expect.minCount ?? 1;
  const frames = () => ctx.wsFrames ?? [];
  const matched = () => frames().filter((frame) => frameMatches(frame, expect));
  const pool = () => frames().filter((frame) => frameFiltered(frame, expect));

  if (expect.absent === true) {
    if (matched().length === 0 && ctx.waitForWsFrames) {
      await ctx.waitForWsFrames((frame) => frameMatches(frame, expect), timeoutMs);
    }
    const found = matched();
    if (found.length > 0) {
      return defect(
        id,
        expect,
        `websocket assertion failed: expected no matching frames, saw ${found.length}. ${summarizeFrames(found)}`,
        found,
      );
    }
    return { assertionId: id, passed: true, expected: expect, actual: 0 };
  }

  const deadline = Date.now() + timeoutMs;
  let waited = false;
  let seenCount = matched().length;
  while (seenCount < minCount && ctx.waitForWsFrames && Date.now() < deadline) {
    waited = true;
    const remaining = Math.max(1, deadline - Date.now());
    const appeared = await ctx.waitForWsFrames((frame) => frameMatches(frame, expect), remaining);
    const now = matched().length;
    if (!appeared || now === seenCount) break;
    seenCount = now;
  }
  const found = matched();
  if (found.length >= minCount) {
    return { assertionId: id, passed: true, expected: expect, actual: found.length };
  }
  const seen = pool().length > 0 ? pool() : frames();
  const waitedNote = waited ? ` after ${timeoutMs}ms` : "";
  return defect(
    id,
    expect,
    `websocket assertion failed${waitedNote}: expected at least ${minCount} matching frame(s), saw ${found.length}. ${summarizeFrames(seen)}`,
    seen,
  );
}

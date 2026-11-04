/** Supported `expect` keys for captured-http (documented for approval + runtime). */
export const CAPTURED_HTTP_EXPECT_KEYS = new Set([
  "statusCode",
  "requestBodyContains",
  "requestJsonBody",
  "jsonBody",
  "responseBodyContains",
  "responseJsonBody",
  "responseJsonSchema",
  "responseHeaders",
  "requestObserved",
  "userCountDelta",
]);

export function listCapturedHttpExpectKeys(): string[] {
  return [...CAPTURED_HTTP_EXPECT_KEYS].sort();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length > 0
  );
}

export function hasSupportedCapturedHttpExpect(expect: Record<string, unknown>): boolean {
  if (expect.userCountDelta === 0) return true;
  if (typeof expect.statusCode === "number") return true;
  if (isNonEmptyString(expect.requestBodyContains)) return true;
  if (isNonEmptyPlainObject(expect.requestJsonBody)) return true;
  if (isNonEmptyPlainObject(expect.jsonBody)) return true;
  if (isNonEmptyString(expect.responseBodyContains)) return true;
  if (isNonEmptyPlainObject(expect.responseJsonBody)) return true;
  if (isNonEmptyPlainObject(expect.responseJsonSchema)) return true;
  if (isNonEmptyPlainObject(expect.responseHeaders)) return true;
  if (expect.requestObserved === true) return true;
  return false;
}

export function validateCapturedHttpExpectShape(expect: Record<string, unknown>): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  for (const key of Object.keys(expect)) {
    if (!CAPTURED_HTTP_EXPECT_KEYS.has(key)) {
      issues.push({
        path: `expect/${key}`,
        message: `HTTP expect 不支持字段 "${key}"；可用: ${listCapturedHttpExpectKeys().join(", ")}`,
      });
    }
  }

  if ("statusCode" in expect) {
    const code = expect.statusCode;
    if (typeof code !== "number" || !Number.isInteger(code) || code < 100 || code > 599) {
      issues.push({ path: "expect/statusCode", message: "statusCode 必须是 100-599 的整数" });
    }
  }

  for (const key of ["requestBodyContains", "responseBodyContains"] as const) {
    if (key in expect && !isNonEmptyString(expect[key])) {
      issues.push({ path: `expect/${key}`, message: `${key} 必须是非空字符串` });
    }
  }

  for (const key of [
    "requestJsonBody",
    "jsonBody",
    "responseJsonBody",
    "responseJsonSchema",
    "responseHeaders",
  ] as const) {
    if (key in expect && !isNonEmptyPlainObject(expect[key])) {
      issues.push({ path: `expect/${key}`, message: `${key} 必须是非空对象` });
    }
  }

  if ("responseHeaders" in expect) {
    const headers = expect.responseHeaders;
    if (isNonEmptyPlainObject(headers)) {
      for (const [name, value] of Object.entries(headers)) {
        if (typeof value !== "string" && typeof value !== "number") {
          issues.push({
            path: `expect/responseHeaders/${name}`,
            message: "responseHeaders 的值必须是字符串或数字",
          });
        } else if (typeof value === "string" && value.trim().length === 0) {
          issues.push({
            path: `expect/responseHeaders/${name}`,
            message: "responseHeaders 的值不能为空字符串",
          });
        }
      }
    }
  }

  if ("requestObserved" in expect && expect.requestObserved !== true) {
    issues.push({ path: "expect/requestObserved", message: "requestObserved 只能为 true" });
  }

  if ("userCountDelta" in expect && expect.userCountDelta !== 0) {
    issues.push({ path: "expect/userCountDelta", message: "userCountDelta 目前仅支持 0" });
  }

  if (!hasSupportedCapturedHttpExpect(expect)) {
    issues.push({
      path: "expect",
      message: "HTTP 断言 expect 至少需要一个受支持字段（如 statusCode、responseJsonBody、responseJsonSchema 等）",
    });
  }
  return issues;
}

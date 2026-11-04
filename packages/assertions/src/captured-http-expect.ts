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

export function hasSupportedCapturedHttpExpect(expect: Record<string, unknown>): boolean {
  if (expect.userCountDelta === 0) return true;
  if (typeof expect.statusCode === "number") return true;
  if (typeof expect.requestBodyContains === "string") return true;
  if (expect.requestJsonBody && typeof expect.requestJsonBody === "object" && !Array.isArray(expect.requestJsonBody)) {
    return true;
  }
  if (expect.jsonBody && typeof expect.jsonBody === "object" && !Array.isArray(expect.jsonBody)) {
    return true;
  }
  if (typeof expect.responseBodyContains === "string") return true;
  if (expect.responseJsonBody && typeof expect.responseJsonBody === "object" && !Array.isArray(expect.responseJsonBody)) {
    return true;
  }
  if (
    expect.responseJsonSchema &&
    typeof expect.responseJsonSchema === "object" &&
    !Array.isArray(expect.responseJsonSchema)
  ) {
    return true;
  }
  if (expect.responseHeaders && typeof expect.responseHeaders === "object" && !Array.isArray(expect.responseHeaders)) {
    return true;
  }
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
  if (!hasSupportedCapturedHttpExpect(expect)) {
    issues.push({
      path: "expect",
      message: "HTTP 断言 expect 至少需要一个受支持字段（如 statusCode、responseJsonBody、responseJsonSchema 等）",
    });
  }
  return issues;
}

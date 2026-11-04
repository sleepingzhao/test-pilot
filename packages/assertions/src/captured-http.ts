import type { TestAssertion, ValidationIssue } from "@testpilot/test-ir";
import type { AssertionContext, AssertionOutcome, CapturedNetworkEntry, RequestRefSpec } from "./types.js";
import { partialJsonMatch } from "./api-match.js";
import { matchesJsonSchema } from "./json-schema-match.js";

function matchNetwork(
  network: CapturedNetworkEntry[],
  spec: RequestRefSpec,
): CapturedNetworkEntry[] {
  return network.filter(
    (n) =>
      n.url.includes(spec.urlIncludes) && (!spec.method || n.method.toUpperCase() === spec.method.toUpperCase()),
  );
}

function headerLookup(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function parseJsonBody(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function validateCapturedHttpAssertion(assertion: TestAssertion): ValidationIssue[] {
  if (assertion.type !== "api") return [];
  const issues: ValidationIssue[] = [];
  if (!assertion.requestRef) {
    issues.push({ path: "requestRef", message: "HTTP 断言需要 requestRef" });
  }
  const expect = assertion.expect ?? {};
  if ("responseJsonSchema" in expect && (expect.responseJsonSchema === null || typeof expect.responseJsonSchema !== "object")) {
    issues.push({ path: "expect/responseJsonSchema", message: "responseJsonSchema 必须是对象" });
  }
  return issues;
}

export async function runCapturedHttpAssertion(
  assertion: TestAssertion,
  ctx: AssertionContext,
): Promise<AssertionOutcome> {
  const id = assertion.id ?? "api-assertion";
  if (assertion.type !== "api") {
    return {
      assertionId: id,
      passed: false,
      errorKind: "ASSERTION_ORACLE",
      message: `expected api assertion, got ${assertion.type}`,
    };
  }

  const network = ctx.network ?? [];
  const ref = assertion.requestRef;
  if (!ref) {
    return {
      assertionId: id,
      passed: false,
      errorKind: "ASSERTION_ORACLE",
      message: "api assertion requires requestRef",
    };
  }

  const spec = ctx.resolveRequestRef?.(ref);
  if (!spec) {
    return {
      assertionId: id,
      passed: false,
      errorKind: "ASSERTION_ORACLE",
      message: `unknown requestRef: ${ref}`,
    };
  }

  const matched = matchNetwork(network, spec);
  const expect = assertion.expect ?? {};

  if (matched.length === 0) {
    return {
      assertionId: id,
      passed: false,
      expected: spec,
      actual: [],
      errorKind: "PRODUCT_DEFECT",
      message: `no network entry matched requestRef ${ref}`,
    };
  }

  const pickForStatus =
    typeof expect.statusCode === "number"
      ? matched.filter((n) => n.status === expect.statusCode)
      : matched;

  if (typeof expect.statusCode === "number" && pickForStatus.length === 0) {
    return {
      assertionId: id,
      passed: false,
      expected: { requestRef: ref, statusCode: expect.statusCode },
      actual: matched.map((n) => ({ url: n.url, status: n.status })),
      errorKind: "PRODUCT_DEFECT",
      message: `no ${spec.method ?? "request"} ${ref} with status ${expect.statusCode}`,
    };
  }

  const pool = pickForStatus.length ? pickForStatus : matched;
  const primary = pool[pool.length - 1]!;

  if (expect.userCountDelta === 0) {
    const created = matched.filter((n) => n.status === 201);
    const passed = created.length === 0;
    return {
      assertionId: id,
      passed,
      expected: { userCountDelta: 0 },
      actual: { create201Count: created.length },
      errorKind: passed ? undefined : "PRODUCT_DEFECT",
      message: passed ? undefined : "unexpected user create (HTTP 201)",
    };
  }

  const failures: string[] = [];
  const actual: Record<string, unknown> = {};

  if (typeof expect.requestBodyContains === "string") {
    const needle = expect.requestBodyContains;
    const hit = pool.some((n) => n.requestBody?.includes(needle));
    actual.requestBodies = pool.map((n) => n.requestBody?.slice(0, 120));
    if (!hit) failures.push(`request body does not contain "${needle}"`);
  }

  const requestJsonExpect =
    expect.requestJsonBody && typeof expect.requestJsonBody === "object" && !Array.isArray(expect.requestJsonBody)
      ? (expect.requestJsonBody as Record<string, unknown>)
      : expect.jsonBody && typeof expect.jsonBody === "object" && !Array.isArray(expect.jsonBody)
        ? (expect.jsonBody as Record<string, unknown>)
        : undefined;

  if (requestJsonExpect) {
    let bodyParsed = parseJsonBody(primary.requestBody);
    if (bodyParsed === undefined && primary.requestBody) {
      bodyParsed = primary.requestBody;
    }
    const passed = partialJsonMatch(requestJsonExpect, bodyParsed);
    actual.requestJson = bodyParsed ?? primary.requestBody?.slice(0, 200);
    if (!passed) failures.push("request JSON body did not match expect.jsonBody / requestJsonBody");
  }

  if (typeof expect.responseBodyContains === "string") {
    const needle = expect.responseBodyContains;
    const hit = pool.some((n) => n.responseBody?.includes(needle));
    actual.responseBodies = pool.map((n) => n.responseBody?.slice(0, 120));
    if (!hit) failures.push(`response body does not contain "${needle}"`);
  }

  if (
    expect.responseJsonBody &&
    typeof expect.responseJsonBody === "object" &&
    !Array.isArray(expect.responseJsonBody)
  ) {
    const parsed = parseJsonBody(primary.responseBody);
    const passed = partialJsonMatch(expect.responseJsonBody as Record<string, unknown>, parsed);
    actual.responseJson = parsed ?? primary.responseBody?.slice(0, 200);
    if (!passed) failures.push("response JSON body did not match expect.responseJsonBody");
  }

  if (expect.responseJsonSchema && typeof expect.responseJsonSchema === "object" && !Array.isArray(expect.responseJsonSchema)) {
    const parsed = parseJsonBody(primary.responseBody);
    const schemaResult = matchesJsonSchema(expect.responseJsonSchema as Record<string, unknown>, parsed);
    actual.responseJson = parsed ?? primary.responseBody?.slice(0, 200);
    if (!schemaResult.ok) failures.push(`response JSON schema: ${schemaResult.message}`);
  }

  if (expect.responseHeaders && typeof expect.responseHeaders === "object" && !Array.isArray(expect.responseHeaders)) {
    const expectedHeaders = expect.responseHeaders as Record<string, unknown>;
    const missing: string[] = [];
    for (const [name, want] of Object.entries(expectedHeaders)) {
      const got = headerLookup(primary.responseHeaders, name);
      const wantStr = String(want ?? "");
      if (got === undefined || !got.toLowerCase().includes(wantStr.toLowerCase())) {
        missing.push(name);
      }
    }
    actual.responseHeaders = primary.responseHeaders;
    if (missing.length) failures.push(`response headers mismatch: ${missing.join(", ")}`);
  }

  if (failures.length) {
    return {
      assertionId: id,
      passed: false,
      expected: { requestRef: ref, ...expect },
      actual,
      errorKind: "PRODUCT_DEFECT",
      message: failures.join("; "),
    };
  }

  const hasExplicitExpect =
    typeof expect.statusCode === "number" ||
    typeof expect.requestBodyContains === "string" ||
    requestJsonExpect ||
    typeof expect.responseBodyContains === "string" ||
    expect.responseJsonBody ||
    expect.responseJsonSchema ||
    expect.responseHeaders;

  if (hasExplicitExpect) {
    return {
      assertionId: id,
      passed: true,
      expected: { requestRef: ref, ...expect },
      actual: {
        url: primary.url,
        status: primary.status,
        ...actual,
      },
    };
  }

  return {
    assertionId: id,
    passed: true,
    expected: spec,
    actual: matched.slice(-3),
  };
}

/** @deprecated use runCapturedHttpAssertion */
export const runApiAssertion = runCapturedHttpAssertion;

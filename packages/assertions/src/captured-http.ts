import type { TestAssertion, ValidationIssue } from "@testpilot/test-ir";
import { redactForEvidence, redactStringBody, redactStrings } from "@testpilot/evidence";
import type { AssertionContext, AssertionOutcome, CapturedNetworkEntry, RequestRefSpec } from "./types.js";
import { partialJsonMatch } from "./api-match.js";
import {
  hasSupportedCapturedHttpExpect,
  validateCapturedHttpExpectShape,
} from "./captured-http-expect.js";
import { matchesJsonSchema, validateJsonSchemaDocument } from "./json-schema-match.js";
import { urlPathMatches } from "./url-path-match.js";

function matchNetwork(
  network: CapturedNetworkEntry[],
  spec: RequestRefSpec,
): CapturedNetworkEntry[] {
  return network.filter(
    (n) =>
      urlPathMatches(n.url, spec.urlIncludes) &&
      (!spec.method || n.method.toUpperCase() === spec.method.toUpperCase()),
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

/** Evidence-safe outcome; matching still uses raw `ctx.network`. */
function withRedactedOutcome(outcome: AssertionOutcome): AssertionOutcome {
  return {
    ...outcome,
    actual: outcome.actual === undefined ? outcome.actual : redactForEvidence(outcome.actual),
    expected: outcome.expected === undefined ? outcome.expected : redactStrings(outcome.expected),
    message: outcome.message === undefined ? outcome.message : redactStringBody(outcome.message),
  };
}

export function validateCapturedHttpAssertion(assertion: TestAssertion): ValidationIssue[] {
  if (assertion.type !== "api") return [];
  const issues: ValidationIssue[] = [];
  if (!assertion.requestRef && !assertion.stepRef) {
    issues.push({ path: "requestRef", message: "HTTP 断言需要 requestRef 或 stepRef" });
  }
  if (assertion.requestRef && assertion.stepRef) {
    issues.push({ path: "stepRef", message: "requestRef 与 stepRef 只能二选一" });
  }
  const expect = (assertion.expect ?? {}) as Record<string, unknown>;
  for (const issue of validateCapturedHttpExpectShape(expect)) {
    issues.push(issue);
  }
  const schema = expect.responseJsonSchema;
  if (
    schema !== null &&
    typeof schema === "object" &&
    !Array.isArray(schema) &&
    Object.keys(schema as Record<string, unknown>).length > 0
  ) {
    const schemaCheck = validateJsonSchemaDocument(schema as Record<string, unknown>);
    if (!schemaCheck.ok) {
      issues.push({
        path: "expect/responseJsonSchema",
        message: `responseJsonSchema 无效: ${schemaCheck.message}`,
      });
    }
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
  const stepRef = assertion.stepRef;
  if (!ref && !stepRef) {
    return {
      assertionId: id,
      passed: false,
      errorKind: "ASSERTION_ORACLE",
      message: "api assertion requires requestRef or stepRef",
    };
  }

  let spec: RequestRefSpec;
  let matched: CapturedNetworkEntry[];
  let label: string;
  if (stepRef) {
    label = `step ${stepRef}`;
    spec = { urlIncludes: label };
    matched = network.filter((n) => n.stepId === stepRef);
  } else {
    const resolved = ctx.resolveRequestRef?.(ref!);
    if (!resolved) {
      return {
        assertionId: id,
        passed: false,
        errorKind: "ASSERTION_ORACLE",
        message: `unknown requestRef: ${ref}`,
      };
    }
    spec = resolved;
    label = `requestRef ${ref}`;
    matched = matchNetwork(network, spec);
  }
  const refLabel = stepRef ? { stepRef } : { requestRef: ref };

  const expect = (assertion.expect ?? {}) as Record<string, unknown>;
  const shapeIssues = validateCapturedHttpExpectShape(expect);
  if (shapeIssues.length) {
    return {
      assertionId: id,
      passed: false,
      errorKind: "ASSERTION_ORACLE",
      message: shapeIssues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      expected: expect,
    };
  }

  const wantsNoRequest = expect.absent === true || expect.requestCount === 0;
  if (wantsNoRequest) {
    const pool =
      typeof expect.statusCode === "number"
        ? matched.filter((n) => n.status === expect.statusCode)
        : matched;
    if (pool.length > 0) {
      return withRedactedOutcome({
        assertionId: id,
        passed: false,
        expected: { ...refLabel, ...expect },
        actual: pool.slice(-3).map((n) => ({ url: n.url, status: n.status })),
        errorKind: "PRODUCT_DEFECT",
        message: `expected no matching request for ${label}`,
      });
    }
    return withRedactedOutcome({
      assertionId: id,
      passed: true,
      expected: { ...refLabel, ...expect },
      actual: { requestCount: 0 },
    });
  }

  if (matched.length === 0) {
    return withRedactedOutcome({
      assertionId: id,
      passed: false,
      expected: { ...refLabel },
      actual: [],
      errorKind: "PRODUCT_DEFECT",
      message: `no network entry matched ${label}`,
    });
  }

  const pickForStatus =
    typeof expect.statusCode === "number"
      ? matched.filter((n) => n.status === expect.statusCode)
      : matched;

  if (typeof expect.statusCode === "number" && pickForStatus.length === 0) {
    return withRedactedOutcome({
      assertionId: id,
      passed: false,
      expected: { ...refLabel, statusCode: expect.statusCode },
      actual: matched.map((n) => ({ url: n.url, status: n.status })),
      errorKind: "PRODUCT_DEFECT",
      message: `no ${spec.method ?? "request"} ${label} with status ${expect.statusCode}`,
    });
  }

  const pool = pickForStatus.length ? pickForStatus : matched;
  const primary = pool[pool.length - 1]!;

  if (expect.userCountDelta === 0) {
    const created = matched.filter((n) => n.status === 201);
    const passed = created.length === 0;
    return withRedactedOutcome({
      assertionId: id,
      passed,
      expected: { userCountDelta: 0 },
      actual: { create201Count: created.length },
      errorKind: passed ? undefined : "PRODUCT_DEFECT",
      message: passed ? undefined : "unexpected user create (HTTP 201)",
    });
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
    return withRedactedOutcome({
      assertionId: id,
      passed: false,
      expected: { ...refLabel, ...expect },
      actual,
      errorKind: "PRODUCT_DEFECT",
      message: failures.join("; "),
    });
  }

  const hasExplicitExpect = hasSupportedCapturedHttpExpect(expect);

  if (hasExplicitExpect) {
    return withRedactedOutcome({
      assertionId: id,
      passed: true,
      expected: { ...refLabel, ...expect },
      actual: {
        url: primary.url,
        status: primary.status,
        ...actual,
      },
    });
  }

  return withRedactedOutcome({
    assertionId: id,
    passed: false,
    errorKind: "ASSERTION_ORACLE",
    message: "HTTP 断言缺少受支持的 expect 字段，无法判定通过或失败",
    expected: { ...refLabel },
    actual: matched.slice(-3),
  });
}

/** @deprecated use runCapturedHttpAssertion */
export const runApiAssertion = runCapturedHttpAssertion;

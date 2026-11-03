import type { Locator, TestAssertion } from "@testpilot/test-ir";
import type { Page } from "playwright";

export type CapturedNetworkEntry = {
  url: string;
  method: string;
  status?: number;
  resourceType?: string;
};

export type RequestRefSpec = {
  urlIncludes: string;
  method?: string;
};

export type FailureKind =
  | "PRODUCT_DEFECT"
  | "LOCATOR_BREAKAGE"
  | "ENVIRONMENT"
  | "TEST_DATA"
  | "ASSERTION_ORACLE"
  | "UNKNOWN";

export type AssertionOutcome = {
  assertionId: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  errorKind?: FailureKind;
  message?: string;
};

export type AssertionContext = {
  page: Page;
  network?: CapturedNetworkEntry[];
  resolveRequestRef?: (ref: string) => RequestRefSpec | undefined;
  resolveRef?: (ref: string) => unknown;
};

export function locatorToPlaywright(locator: Locator): string {
  if (locator.testId) {
    return `[data-testid="${locator.testId}"]`;
  }
  if (locator.css) {
    return locator.css;
  }
  if (locator.role) {
    const name = locator.name ? `:has-text("${locator.name}")` : "";
    return `role=${locator.role}${name}`;
  }
  if (locator.label) {
    return `label=${locator.label}`;
  }
  if (locator.placeholder) {
    return `placeholder=${locator.placeholder}`;
  }
  throw new Error("locator must include testId, css, role, label, or placeholder");
}

export async function runUiAssertion(
  assertion: TestAssertion,
  ctx: AssertionContext,
): Promise<AssertionOutcome> {
  const id = assertion.id ?? "ui-assertion";
  if (assertion.type !== "ui") {
    return {
      assertionId: id,
      passed: false,
      errorKind: "ASSERTION_ORACLE",
      message: `expected ui assertion, got ${assertion.type}`,
    };
  }

  try {
    if (assertion.target && !assertion.contains) {
      const t = assertion.target;
      let el;
      if (t.testId) el = ctx.page.getByTestId(t.testId);
      else if (t.role)
        el = t.name
          ? ctx.page.getByRole(t.role as Parameters<Page["getByRole"]>[0], { name: t.name, exact: true })
          : ctx.page.getByRole(t.role as Parameters<Page["getByRole"]>[0]);
      else if (t.label) el = ctx.page.getByLabel(t.label);
      else if (t.placeholder) el = ctx.page.getByPlaceholder(t.placeholder);
      else if (t.css) el = ctx.page.locator(t.css);
      else throw new Error("empty target");
      await el.waitFor({ state: "visible", timeout: 10_000 });
      return { assertionId: id, passed: true, expected: "visible", actual: "visible" };
    }

    if (assertion.contains && assertion.target) {
      let el;
      const t = assertion.target;
      if (t.testId) el = ctx.page.getByTestId(t.testId);
      else if (t.role)
        el = t.name
          ? ctx.page.getByRole(t.role as Parameters<Page["getByRole"]>[0], { name: t.name, exact: true })
          : ctx.page.getByRole(t.role as Parameters<Page["getByRole"]>[0]);
      else if (t.label) el = ctx.page.getByLabel(t.label);
      else if (t.placeholder) el = ctx.page.getByPlaceholder(t.placeholder);
      else if (t.css) el = ctx.page.locator(t.css);
      else throw new Error("empty target");
      await el.waitFor({ state: "visible", timeout: 10_000 });
      const text = await el.innerText();
      const passed = text.includes(assertion.contains);
      return {
        assertionId: id,
        passed,
        expected: assertion.contains,
        actual: text,
        errorKind: passed ? undefined : "PRODUCT_DEFECT",
        message: passed ? undefined : `text does not contain "${assertion.contains}"`,
      };
    }

    if (assertion.contains) {
      const body = ctx.page.locator("body");
      const text = await body.innerText();
      const passed = text.includes(assertion.contains);
      return {
        assertionId: id,
        passed,
        expected: assertion.contains,
        actual: text.slice(0, 500),
        errorKind: passed ? undefined : "PRODUCT_DEFECT",
      };
    }

    return {
      assertionId: id,
      passed: false,
      errorKind: "ASSERTION_ORACLE",
      message: "ui assertion requires contains and/or target",
    };
  } catch (err) {
    return {
      assertionId: id,
      passed: false,
      errorKind: "LOCATOR_BREAKAGE",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function matchNetwork(
  network: CapturedNetworkEntry[],
  spec: RequestRefSpec,
): CapturedNetworkEntry[] {
  return network.filter(
    (n) =>
      n.url.includes(spec.urlIncludes) && (!spec.method || n.method.toUpperCase() === spec.method.toUpperCase()),
  );
}

export async function runApiAssertion(
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

  if (typeof expect.statusCode === "number") {
    const hit = matched.some((n) => n.status === expect.statusCode);
    return {
      assertionId: id,
      passed: hit,
      expected: { requestRef: ref, statusCode: expect.statusCode },
      actual: matched.map((n) => ({ url: n.url, status: n.status })),
      errorKind: hit ? undefined : "PRODUCT_DEFECT",
      message: hit ? undefined : `no ${spec.method ?? "request"} ${ref} with status ${expect.statusCode}`,
    };
  }

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

  return {
    assertionId: id,
    passed: true,
    expected: spec,
    actual: matched.slice(-3),
  };
}

export async function runAssertion(
  assertion: TestAssertion,
  ctx: AssertionContext,
): Promise<AssertionOutcome> {
  switch (assertion.type) {
    case "ui":
      return runUiAssertion(assertion, ctx);
    case "api":
      return runApiAssertion(assertion, ctx);
    default:
      return {
        assertionId: assertion.id ?? assertion.type,
        passed: false,
        errorKind: "UNKNOWN",
        message: `${assertion.type} assertions not implemented in v0.1 scaffold`,
      };
  }
}

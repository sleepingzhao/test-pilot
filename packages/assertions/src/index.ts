import type { Locator, TestAssertion } from "@testpilot/test-ir";
import type { Page } from "playwright";
import { countVisibleListRecords } from "@testpilot/context-web";
import { runCapturedHttpAssertion, validateCapturedHttpAssertion } from "./captured-http.js";
import { getAgentConfigBundle, getDbConfigBundle } from "@testpilot/fixtures";
import {
  runPostgresReadonlyAssertion,
  validatePostgresReadonlyAssertion,
} from "./postgres-readonly.js";
import { runOtelTraceAssertion, validateOtelTraceAssertion } from "./otel-trace.js";
import { runWsAssertion, validateWsAssertion } from "./ws.js";
import {
  getAssertionProvider,
  registerAssertionProvider,
  resolveAssertionProviderId,
} from "./providers.js";
import type { AssertionContext, AssertionOutcome } from "./types.js";

export type {
  AssertionContext,
  AssertionOutcome,
  CapturedNetworkEntry,
  FailureKind,
  RequestRefSpec,
} from "./types.js";
export { runApiAssertion, runCapturedHttpAssertion, validateCapturedHttpAssertion } from "./captured-http.js";
export { urlPathMatches } from "./url-path-match.js";
export {
  runPostgresReadonlyAssertion,
  validatePostgresReadonlyAssertion,
} from "./postgres-readonly.js";
export { runOtelTraceAssertion, validateOtelTraceAssertion } from "./otel-trace.js";
export { runWsAssertion, validateWsAssertion } from "./ws.js";
export type { AssertionProvider } from "./providers.js";

export {
  getAssertionProvider,
  listAssertionProviders,
  registerAssertionProvider,
  resolveAssertionProviderId,
  validateAssertionProviders,
} from "./providers.js";

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

/** Success text often renders a moment after the last request settles. */
function uiAssertTimeoutMs(): number {
  const raw = Number(process.env.TESTPILOT_UI_ASSERT_TIMEOUT_MS ?? 8_000);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 30_000) : 8_000;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function listRecordIssue(assertion: TestAssertion) {
  if (!assertion.listRecords) return;
  if (assertion.type !== "ui" || !["table", "grid", "list"].includes(assertion.target?.role ?? "") ||
      !Number.isInteger(assertion.minCount) || (assertion.minCount ?? 0) < 2 ||
      assertion.contains !== undefined || assertion.notContains !== undefined) {
    return { path: "/listRecords", message: "listRecords requires a table, grid, or list target and minCount >= 2 without text predicates" };
  }
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

  const listIssue = listRecordIssue(assertion);
  if (listIssue) return { assertionId: id, passed: false, errorKind: "ASSERTION_ORACLE", message: listIssue.message };

  try {
    const root = ctx.frame ? ctx.page.frameLocator(ctx.frame) : ctx.page;
    const findTarget = (t: NonNullable<typeof assertion.target>) => {
      if (t.testId) return root.getByTestId(t.testId);
      if (t.role)
        return t.name
          ? root.getByRole(t.role as Parameters<Page["getByRole"]>[0], { name: t.name, exact: true })
          : root.getByRole(t.role as Parameters<Page["getByRole"]>[0]);
      if (t.name) return root.getByText(t.name, { exact: false });
      if (t.label) return root.getByLabel(t.label);
      if (t.placeholder) return root.getByPlaceholder(t.placeholder);
      if (t.css) return root.locator(t.css);
      throw new Error("empty target");
    };
    if (assertion.urlIncludes) {
      const deadline = Date.now() + uiAssertTimeoutMs();
      let current = ctx.page.url();
      while (!current.includes(assertion.urlIncludes) && Date.now() < deadline) {
        await sleep(100);
        current = ctx.page.url();
      }
      if (!current.includes(assertion.urlIncludes)) {
        return {
          assertionId: id,
          passed: false,
          expected: `url includes "${assertion.urlIncludes}"`,
          actual: current,
          errorKind: "PRODUCT_DEFECT",
          message: `url does not include "${assertion.urlIncludes}"`,
        };
      }
      if (!assertion.target && !assertion.contains && !assertion.notContains) {
        return { assertionId: id, passed: true, expected: `url includes "${assertion.urlIncludes}"`, actual: current };
      }
    }
    const matches = (text: string) =>
      (!assertion.contains || text.includes(assertion.contains)) &&
      (!assertion.notContains || !text.includes(assertion.notContains));

    if (assertion.target && typeof assertion.minCount === "number") {
      const locator = findTarget(assertion.target);
      const minCount = assertion.minCount;
      const deadline = Date.now() + uiAssertTimeoutMs();
      const countMatches = assertion.listRecords
        ? () => countVisibleListRecords(locator, assertion.target?.role ?? "")
        : () => locator.count();
      let count = await countMatches();
      while (count < minCount && Date.now() < deadline) {
        await sleep(100);
        count = await countMatches();
      }
      if (count < minCount) {
        return {
          assertionId: id,
          passed: false,
          errorKind: "PRODUCT_DEFECT",
          message: `expected at least ${minCount} ${assertion.listRecords ? "visible business records" : "elements"} for target, found ${count}`,
          expected: `>= ${minCount}`,
          actual: String(count),
        };
      }
      if (!assertion.contains && !assertion.notContains) {
        return {
          assertionId: id,
          passed: true,
          expected: `>= ${minCount}`,
          actual: String(count),
        };
      }
    }

    if (assertion.target && !assertion.contains && !assertion.notContains) {
      await findTarget(assertion.target).first().waitFor({ state: "visible", timeout: 10_000 });
      return { assertionId: id, passed: true, expected: "visible", actual: "visible" };
    }

    if (assertion.target) {
      const el = findTarget(assertion.target).first();
      await el.waitFor({ state: "visible", timeout: 10_000 });
      const deadline = Date.now() + uiAssertTimeoutMs();
      let text = await el.innerText().catch(() => "");
      while (!matches(text) && Date.now() < deadline) {
        await sleep(100);
        text = await el.innerText().catch(() => text);
      }
      const passed = matches(text);
      return {
        assertionId: id,
        passed,
        expected: assertion.contains ?? `not "${assertion.notContains}"`,
        actual: text,
        errorKind: passed ? undefined : "PRODUCT_DEFECT",
        message: passed
          ? undefined
          : assertion.contains
            ? `text does not contain "${assertion.contains}"`
            : `text still contains "${assertion.notContains}"`,
      };
    }

    if (assertion.contains || assertion.notContains) {
      const scoped = ctx.frame
        ? ctx.page.frameLocator(ctx.frame).locator("body")
        : ctx.page.locator("body");
      const deadline = Date.now() + uiAssertTimeoutMs();
      let text = await scoped.innerText().catch(() => "");
      while (!matches(text) && Date.now() < deadline) {
        await sleep(100);
        text = await scoped.innerText().catch(() => text);
      }
      const passed = matches(text);
      return {
        assertionId: id,
        passed,
        expected: assertion.contains ?? `not "${assertion.notContains}"`,
        actual: text.slice(0, 500),
        errorKind: passed ? undefined : "PRODUCT_DEFECT",
        message: passed
          ? undefined
          : assertion.contains && !text.includes(assertion.contains)
            ? `text does not contain "${assertion.contains}"`
            : `text still contains "${assertion.notContains}"`,
      };
    }

    return {
      assertionId: id,
      passed: false,
      errorKind: "ASSERTION_ORACLE",
      message: "ui assertion requires contains, notContains, and/or target",
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

export async function runAssertion(
  assertion: TestAssertion,
  ctx: AssertionContext,
): Promise<AssertionOutcome> {
  const assertionId = assertion.id ?? assertion.type;
  const providerId = resolveAssertionProviderId(assertion);

  if (!providerId) {
    return {
      assertionId,
      passed: false,
      errorKind: "ASSERTION_ORACLE",
      message: `${assertion.type} assertion requires an explicit provider`,
    };
  }

  const provider = getAssertionProvider(providerId);
  if (!provider) {
    return {
      assertionId,
      passed: false,
      errorKind: "ASSERTION_ORACLE",
      message: `unknown assertion provider: ${providerId}`,
    };
  }

  if (provider.kind !== assertion.type) {
    return {
      assertionId,
      passed: false,
      errorKind: "ASSERTION_ORACLE",
      message: `provider ${providerId} kind ${provider.kind} does not match assertion type ${assertion.type}`,
    };
  }

  return provider.run(assertion, ctx);
}

registerAssertionProvider({
  id: "playwright-ui",
  kind: "ui",
  validate: assertion => {
    const issue = listRecordIssue(assertion);
    return issue ? [issue] : [];
  },
  run: runUiAssertion,
});

registerAssertionProvider({
  id: "captured-http",
  kind: "api",
  validate: validateCapturedHttpAssertion,
  run: runCapturedHttpAssertion,
});

registerAssertionProvider({
  id: "postgres-readonly",
  kind: "db",
  validate: (assertion) =>
    validatePostgresReadonlyAssertion(assertion, (ref) => getDbConfigBundle(ref)),
  run: runPostgresReadonlyAssertion,
});

registerAssertionProvider({
  id: "otel-trace",
  kind: "agent",
  validate: (assertion) =>
    validateOtelTraceAssertion(assertion, (ref) => getAgentConfigBundle(ref)),
  run: runOtelTraceAssertion,
});

registerAssertionProvider({
  id: "ws",
  kind: "event",
  validate: validateWsAssertion,
  run: runWsAssertion,
});

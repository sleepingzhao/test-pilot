import type { Locator, TestAssertion } from "@testpilot/test-ir";
import type { Page } from "playwright";
import { runCapturedHttpAssertion, validateCapturedHttpAssertion } from "./captured-http.js";
import { getDbConfigBundle } from "@testpilot/fixtures";
import {
  runPostgresReadonlyAssertion,
  validatePostgresReadonlyAssertion,
} from "./postgres-readonly.js";
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
export {
  runPostgresReadonlyAssertion,
  validatePostgresReadonlyAssertion,
} from "./postgres-readonly.js";
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
      await ctx.page
        .waitForFunction("document.body && document.body.innerText.trim().length > 0", { timeout: 20_000 })
        .catch(() => undefined);
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

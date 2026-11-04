import type { TestAssertion, TestIR, ValidationIssue } from "@testpilot/test-ir";
import type { AssertionContext, AssertionOutcome } from "./types.js";

export type AssertionProvider = {
  id: string;
  kind: TestAssertion["type"];
  validate?(assertion: TestAssertion): ValidationIssue[];
  run: (assertion: TestAssertion, ctx: AssertionContext) => Promise<AssertionOutcome>;
};

const registry = new Map<string, AssertionProvider>();

const DEFAULT_PROVIDER_BY_TYPE: Partial<Record<TestAssertion["type"], string>> = {
  ui: "playwright-ui",
  api: "captured-http",
};

const TYPES_REQUIRING_EXPLICIT_PROVIDER = new Set<TestAssertion["type"]>([
  "db",
  "agent",
  "event",
  "custom",
]);

export function registerAssertionProvider(provider: AssertionProvider): void {
  if (registry.has(provider.id)) {
    throw new Error(`assertion provider already registered: ${provider.id}`);
  }
  registry.set(provider.id, provider);
}

export function getAssertionProvider(id: string): AssertionProvider | undefined {
  return registry.get(id);
}

export function listAssertionProviders(): AssertionProvider[] {
  return [...registry.values()];
}

export function resolveAssertionProviderId(assertion: TestAssertion): string | undefined {
  if (assertion.provider) return assertion.provider;
  if (TYPES_REQUIRING_EXPLICIT_PROVIDER.has(assertion.type)) return undefined;
  return DEFAULT_PROVIDER_BY_TYPE[assertion.type];
}

export function validateAssertionProviders(ir: TestIR): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [i, assertion] of ir.assertions.entries()) {
    const basePath = `/assertions/${i}`;
    const providerId = resolveAssertionProviderId(assertion);

    if (!providerId) {
      issues.push({
        path: `${basePath}/provider`,
        message: `${assertion.type} 断言必须指定 provider`,
      });
      continue;
    }

    const provider = getAssertionProvider(providerId);
    if (!provider) {
      issues.push({
        path: `${basePath}/provider`,
        message: `未知的断言 Provider: ${providerId}`,
      });
      continue;
    }

    if (provider.kind !== assertion.type) {
      issues.push({
        path: `${basePath}/provider`,
        message: `Provider ${providerId} 的类型为 ${provider.kind}，与断言 type ${assertion.type} 不匹配`,
      });
    }

    if (provider.validate) {
      for (const issue of provider.validate(assertion)) {
        issues.push({
          path: issue.path.startsWith("/") ? issue.path : `${basePath}/${issue.path}`,
          message: issue.message,
        });
      }
    }
  }
  return issues;
}

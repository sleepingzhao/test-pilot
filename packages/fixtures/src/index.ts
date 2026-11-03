import type { TestIR } from "@testpilot/test-ir";

export type RunEnvironment = {
  baseUrl: string;
  /** Named env refs, e.g. staging-console → URL */
  baseUrlRefs?: Record<string, string>;
  /** Fixture-scoped values; secrets via env, never in IR */
  fixtureValues?: Record<string, string>;
  commitSha?: string;
};

export function resolveFixtureRefs(fixtureName: string | undefined, env: RunEnvironment): void {
  if (!fixtureName) return;
  // V0.1: fixture hook only; setup/teardown comes in v0.3
  void env;
}

export function resolveValueRefs(ir: TestIR, env: RunEnvironment): Record<string, string> {
  const map: Record<string, string> = {};
  for (const step of ir.steps) {
    if (step.valueRef) {
      const key = step.valueRef;
      const value = env.fixtureValues?.[key] ?? env.fixtureValues?.[key.replace(/^fixture\./, "")];
      if (value !== undefined) {
        map[key] = value;
      }
    }
  }
  return map;
}

export function resolveBaseUrl(ir: TestIR, env: RunEnvironment): string {
  if (ir.baseUrlRef && env.baseUrlRefs?.[ir.baseUrlRef]) {
    return env.baseUrlRefs[ir.baseUrlRef];
  }
  return env.baseUrl;
}

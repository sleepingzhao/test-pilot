import type { TestIR } from "@testpilot/test-ir";

export type RunEnvironment = {
  baseUrl: string;
  /** Named env refs, e.g. staging-console → URL */
  baseUrlRefs?: Record<string, string>;
  /** Maps requestRef in IR to URL/method patterns (roadmap §8). */
  requestRefs?: Record<string, { urlIncludes: string; method?: string }>;
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
  const map: Record<string, string> = { ...(env.fixtureValues ?? {}) };
  for (const step of ir.steps) {
    if (!step.valueRef) continue;
    if (map[step.valueRef] !== undefined) continue;
    const envKey = `TESTPILOT_${step.valueRef.replace(/\./g, "_").toUpperCase()}`;
    const fromEnv = process.env[envKey];
    if (fromEnv !== undefined && fromEnv !== "") {
      map[step.valueRef] = fromEnv;
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

const DEFAULT_REQUEST_REFS: Record<string, { urlIncludes: string; method?: string }> = {
  "users-create-attempt": { urlIncludes: "/api/users", method: "POST" },
  "users-lookup-existing-email": { urlIncludes: "/api/users", method: "POST" },
};

export function resolveRequestRef(
  ref: string,
  env: RunEnvironment,
): { urlIncludes: string; method?: string } | undefined {
  if (env.requestRefs?.[ref]) return env.requestRefs[ref];
  return DEFAULT_REQUEST_REFS[ref];
}

import type { TestIR } from "@testpilot/test-ir";
import type { RunEnvironment } from "@testpilot/fixtures";

export const DEMO_BASE_URL = "http://127.0.0.1:4173";

export function pilotBaseUrl(): string {
  return process.env.TESTPILOT_PILOT_BASE_URL ?? "https://your-staging-host.example";
}

export function buildRunEnvironment(primaryBaseUrl?: string): RunEnvironment {
  const primary = primaryBaseUrl ?? DEMO_BASE_URL;
  return {
    baseUrl: primary,
    baseUrlRefs: {
      "staging-console": DEMO_BASE_URL,
      "default-env": primary,
      "pilot-admin": pilotBaseUrl(),
    },
    fixtureValues: {},
  };
}

export function pilotSecretsConfigured(): boolean {
  return Boolean(process.env.TESTPILOT_ENV_ADMIN_PHONE && process.env.TESTPILOT_ENV_ADMIN_PASSWORD);
}

export function testNeedsPilotSecrets(ir: TestIR): boolean {
  return ir.steps.some((s) => s.valueRef?.startsWith("env."));
}

export function resolveIrBaseUrl(ir: TestIR, env: RunEnvironment): string {
  if (ir.baseUrlRef && env.baseUrlRefs?.[ir.baseUrlRef]) {
    return env.baseUrlRefs[ir.baseUrlRef];
  }
  return env.baseUrl;
}

export function uniqueTargetBaseUrls(tests: Array<{ ir: TestIR }>, env: RunEnvironment): string[] {
  const urls = new Set<string>();
  for (const t of tests) {
    urls.add(resolveIrBaseUrl(t.ir, env));
  }
  return [...urls];
}

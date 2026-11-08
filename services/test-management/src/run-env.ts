import type { TestIR } from "@testpilot/test-ir";
import { resolveValueRefEnvKey, type RunEnvironment } from "@testpilot/fixtures";

export const DEMO_BASE_URL = "http://127.0.0.1:4173";

export function pilotBaseUrl(): string {
  return process.env.TESTPILOT_PILOT_BASE_URL ?? "";
}

export function realBaseUrl(): string {
  return process.env.TESTPILOT_REAL_BASE_URL ?? "";
}

export function realSecretsConfigured(): boolean {
  return Boolean(
    process.env.TESTPILOT_ENV_REAL_ENTERPRISE_ID &&
      process.env.TESTPILOT_ENV_REAL_USER_ID &&
      process.env.TESTPILOT_ENV_REAL_PASSWORD,
  );
}

export function buildRunEnvironment(primaryBaseUrl?: string): RunEnvironment {
  const primary = primaryBaseUrl ?? DEMO_BASE_URL;
  const adminPhone = process.env.TESTPILOT_ENV_ADMIN_PHONE?.trim();
  const adminPassword = process.env.TESTPILOT_ENV_ADMIN_PASSWORD?.trim();
  const real = realBaseUrl().trim();
  return {
    baseUrl: primary,
    baseUrlRefs: {
      "staging-console": DEMO_BASE_URL,
      "default-env": primary,
      "pilot-admin": pilotBaseUrl(),
      ...(real ? { "real-env": real } : {}),
    },
    fixtureValues: {
      ...(adminPhone ? { "env.adminPhone": adminPhone } : {}),
      ...(adminPassword ? { "env.adminPassword": adminPassword } : {}),
    },
  };
}

export function isPilotTest(test: {
  id: string;
  title: string;
  ir?: { baseUrlRef?: string };
}): boolean {
  if (test.title.includes("【试点】")) return true;
  if (test.id.startsWith("pilot-auto-") || test.id.startsWith("pilot-admin-")) return true;
  if (test.ir?.baseUrlRef === "pilot-admin") return true;
  return false;
}

export function pilotSecretsConfigured(): boolean {
  return Boolean(process.env.TESTPILOT_ENV_ADMIN_PHONE && process.env.TESTPILOT_ENV_ADMIN_PASSWORD);
}

/** Env keys referenced by the IR that are currently missing or empty. */
export function missingEnvRefs(ir: TestIR): string[] {
  const missing = new Set<string>();
  for (const step of ir.steps) {
    if (!step.valueRef) continue;
    if (!step.valueRef.startsWith("env.") && !step.valueRef.startsWith("fixture.")) continue;
    const key = resolveValueRefEnvKey(step.valueRef);
    if (!process.env[key]?.trim()) missing.add(key);
  }
  return [...missing];
}

/** Map an absolute target URL to the configured env ref, or pin its origin in the IR. */
export function baseUrlTargetFor(rawUrl: string): { baseUrl?: string; baseUrlRef?: string } {
  try {
    const origin = new URL(rawUrl).origin;
    if (origin === new URL(DEMO_BASE_URL).origin) return { baseUrlRef: "staging-console" };
    const pilot = pilotBaseUrl();
    if (pilot) {
      try {
        if (origin === new URL(pilot).origin) return { baseUrlRef: "pilot-admin" };
      } catch {
        /* malformed pilot URL is reported when the test runs */
      }
    }
    return { baseUrl: origin };
  } catch {
    return {};
  }
}

/** Apply a target URL without leaving a conflicting baseUrl/baseUrlRef pair. */
export function applyBaseUrlTarget<T extends object>(
  ir: T & { baseUrl?: string; baseUrlRef?: string },
  rawUrl: string,
): T & { baseUrl?: string; baseUrlRef?: string } {
  const target = baseUrlTargetFor(rawUrl);
  const next: T & { baseUrl?: string; baseUrlRef?: string } = { ...ir, ...target };
  if (target.baseUrlRef) delete next.baseUrl;
  if (target.baseUrl) delete next.baseUrlRef;
  return next;
}

export function resolveIrBaseUrl(ir: TestIR, env: RunEnvironment): string {
  if (ir.baseUrl) return ir.baseUrl;
  if (ir.baseUrlRef) {
    const ref = env.baseUrlRefs?.[ir.baseUrlRef];
    if (!ref) throw new Error(`baseUrlRef "${ir.baseUrlRef}" 未配置（检查 .env）`);
    return ref;
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

/** Absolute navigate targets bypass baseUrl; they must still clear the allow-list. */
export function absoluteStepUrls(tests: Array<{ ir: TestIR }>): string[] {
  const urls = new Set<string>();
  for (const t of tests) {
    for (const step of t.ir.steps ?? []) {
      const path = step.path ?? "";
      if (step.action === "navigate" && /^https?:\/\//i.test(path)) urls.add(path);
    }
  }
  return [...urls];
}

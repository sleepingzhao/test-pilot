import type { RunEnvironment } from "@testpilot/fixtures";
import type { TestIR, TestPolicy } from "@testpilot/test-ir";
import type { RunOptions } from "@testpilot/runner-web";
import { buildRunEnvironment } from "./run-env.js";
import { isRealTarget, loginRealPage } from "./real-login.js";

/**
 * Opt-in only: the HTTP method does not tell us whether a request mutates data — enterprise
 * backends commonly POST pure queries. The provided account's own permissions are the real
 * boundary, so the guard ships off unless the operator asks for it.
 */
export function readOnlyGuardEnabled(): boolean {
  const raw = process.env.TESTPILOT_READONLY;
  return raw === "1" || raw === "true";
}

export function shouldReadOnlyNetwork(baseUrl: string, policy?: TestPolicy): boolean {
  if (!readOnlyGuardEnabled()) return false;
  return isRealTarget(baseUrl) && policy?.allowMutation !== true;
}

/**
 * The IR's primary target, not the project default: a test with `baseUrlRef: "real-env"`
 * must run with real login and the real evidence policy even when the caller passes the
 * demo URL as a fallback.
 */
export function primaryTargetBaseUrl(
  ir: Pick<TestIR, "baseUrl" | "baseUrlRef" | "actors">,
  fallbackBaseUrl: string,
  env: RunEnvironment = buildRunEnvironment(fallbackBaseUrl),
): string {
  const primaryActor = ir.actors?.find((actor) => actor.id === "primary") ?? ir.actors?.[0];
  const baseUrl = primaryActor?.baseUrl ?? ir.baseUrl;
  const ref = primaryActor?.baseUrlRef ?? ir.baseUrlRef;
  const fromRef = ref ? env.baseUrlRefs?.[ref] : undefined;
  return baseUrl?.trim() || fromRef?.trim() || fallbackBaseUrl;
}

export function runOptionsFor(
  fallbackBaseUrl: string,
  runId: string,
  artifactsDir: string,
  ir: Pick<TestIR, "policy" | "baseUrl" | "baseUrlRef" | "actors">,
): RunOptions {
  const env = buildRunEnvironment(fallbackBaseUrl);
  const targetBaseUrl = primaryTargetBaseUrl(ir, fallbackBaseUrl, env);
  const options: RunOptions = {
    runId,
    headless: true,
    artifactsDir,
    env,
  };
  if (isRealTarget(targetBaseUrl)) {
    options.login = (page, _context, url, account) => loginRealPage(page, url, account ?? "primary");
    // Evidence policy is independent of the write guard: real targets never keep
    // screenshots/trace or payload bodies on disk (V7-12c).
    options.realTarget = true;
  }
  if (shouldReadOnlyNetwork(targetBaseUrl, ir.policy)) {
    options.readOnlyNetwork = true;
  }
  return options;
}

import type { TestIR, TestPolicy } from "@testpilot/test-ir";
import type { RunOptions } from "@testpilot/runner-web";
import { buildRunEnvironment } from "./run-env.js";
import { isRealTarget, loginRealPage } from "./real-login.js";

export function shouldReadOnlyNetwork(baseUrl: string, policy?: TestPolicy): boolean {
  return isRealTarget(baseUrl) && policy?.allowMutation !== true;
}

export function runOptionsFor(baseUrl: string, runId: string, artifactsDir: string, ir: Pick<TestIR, "policy">): RunOptions {
  const options: RunOptions = {
    runId,
    headless: true,
    artifactsDir,
    env: buildRunEnvironment(baseUrl),
  };
  if (isRealTarget(baseUrl)) {
    options.login = (page, _context, url, account) => loginRealPage(page, url, account ?? "primary");
  }
  if (shouldReadOnlyNetwork(baseUrl, ir.policy)) {
    options.readOnlyNetwork = true;
  }
  return options;
}

import { requestPathIssue, type Locator as TargetLocator, type TestIR, type TestStep } from "@testpilot/test-ir";
import { runAssertion, urlPathMatches } from "@testpilot/assertions";
import type { DirectNetworkInput, RunArtifacts } from "@testpilot/evidence";
import { classifyFailure, createEvidenceCollector, maxRunAttempts, redactForEvidence, redactStringBody, redactStrings, shouldRetryAfterFailure } from "@testpilot/evidence";
import type { RunEnvironment } from "@testpilot/fixtures";
import { buildReadonlyDbClient, buildAgentTraceClient, getDbConfigBundle, getAgentConfigBundle, resolveBaseUrl, resolveFixtureRefs, resolveRequestRef, resolveValueRefs } from "@testpilot/fixtures";
import { executeSelectCascader } from "./select-cascader.js";
import {
  assignResponseVariables,
  lookupProcessEnv,
  redactSecretValues,
  renderRequestStep,
  requestBodyForEvidence,
} from "./request-template.js";
import { chromium, type Browser, type BrowserContext, type Locator as PwLocator, type Page } from "playwright";

export type RunStatus = "passed" | "failed" | "error";

export type StepResult = {
  stepId: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  message?: string;
};

export type RunResult = {
  runId: string;
  testId: string;
  testVersion: number;
  status: RunStatus;
  startedAt: string;
  completedAt: string;
  steps: StepResult[];
  assertions: Awaited<ReturnType<typeof runAssertion>>[];
  artifacts: RunArtifacts;
  metrics: {
    durationMs: number;
    llmTokensUsed: number;
    failureKind?: string;
    attemptCount: number;
    flakeRecovery?: boolean;
  };
  /** Visible success/alerts right after the steps; used to derive a real success assertion. */
  finalSignals?: string[];
};

export type RunOptions = {
  runId?: string;
  headless?: boolean;
  artifactsDir?: string;
  env: RunEnvironment;
};

type AssertionResult = Awaited<ReturnType<typeof runAssertion>>;

function redactAssertionForEvidence(outcome: AssertionResult): AssertionResult {
  return {
    ...outcome,
    actual: outcome.actual === undefined ? outcome.actual : (redactForEvidence(outcome.actual) as AssertionResult["actual"]),
    expected: outcome.expected === undefined ? outcome.expected : redactStrings(outcome.expected),
    message: outcome.message === undefined ? outcome.message : redactStringBody(outcome.message),
  };
}

function locatorCandidates(page: Page, target: TargetLocator): PwLocator[] {
  const out: PwLocator[] = [];
  if (target.testId) out.push(page.getByTestId(target.testId));
  if (target.role) {
    out.push(
      target.name
        ? page.getByRole(target.role as Parameters<Page["getByRole"]>[0], { name: target.name, exact: true })
        : page.getByRole(target.role as Parameters<Page["getByRole"]>[0]),
    );
    if (target.name) {
      out.push(page.getByText(target.name, { exact: false }));
    }
  } else if (target.name) {
    out.push(page.getByText(target.name, { exact: false }));
  }
  if (target.label) out.push(page.getByLabel(target.label));
  if (target.placeholder) out.push(page.getByPlaceholder(target.placeholder));
  if (target.css) out.push(page.locator(target.css));
  if (out.length === 0) throw new Error("unsupported locator");
  return out;
}

async function captureFinalSignals(page: Page): Promise<string[]> {
  const raw = await page
    .evaluate(`(() => {
      const out = [];
      const nodes = document.querySelectorAll('[role="alert"], .el-message, .toast, [class*="success"], [class*="alert"]');
      for (const node of Array.from(nodes)) {
        const text = (node.textContent || "").trim().replace(/\\s+/g, " ");
        if (text.length >= 2 && text.length <= 80 && !out.includes(text)) out.push(text);
        if (out.length >= 5) break;
      }
      return out;
    })()`)
    .catch(() => [] as string[]);
  return (raw as string[]).map((text) => redactStringBody(text));
}

async function resolveStepLocator(page: Page, target: TargetLocator, timeoutMs = 4_000) {
  const candidates = locatorCandidates(page, target);
  for (let i = 0; i < candidates.length; i++) {
    const loc = candidates[i]!;
    try {
      await loc.first().waitFor({ state: "visible", timeout: i === 0 ? 15_000 : timeoutMs });
      return loc.first();
    } catch {
      if (i === candidates.length - 1) throw new Error(`locator not found: ${JSON.stringify(target)}`);
    }
  }
  return candidates[0]!.first();
}

/** Remote pilot pages can take >30s under load; 45s default, bounded by env. */
export function navTimeoutMs(): number {
  const raw = Number(process.env.TESTPILOT_NAV_TIMEOUT_MS ?? 45_000);
  return Number.isFinite(raw) && raw >= 5_000 ? Math.min(raw, 120_000) : 45_000;
}

function redactSecretHeaderValues(
  headers: Record<string, string> | undefined,
  secrets: readonly string[],
): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, redactSecretValues(value, secrets)]),
  );
}

/** Resolve a request path against baseUrl and reject anything that is not that origin. */
export function resolveSameOriginRequestUrl(path: string | undefined, baseUrl: string): URL {
  if (!path?.trim()) throw new Error("request requires path");
  const pathIssue = requestPathIssue(path);
  if (pathIssue) throw new Error(pathIssue);
  if (!baseUrl?.trim()) throw new Error("request requires baseUrl");
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error("request baseUrl is not a valid URL");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("request blocked: baseUrl must be http or https");
  }
  if (base.username || base.password) throw new Error("request blocked: baseUrl must not include credentials");
  let target: URL;
  try {
    target = new URL(path, base);
  } catch {
    throw new Error("request path is not a valid URL");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("request blocked: only http and https URLs are allowed");
  }
  if (target.username || target.password) throw new Error("request blocked: URL credentials are not allowed");
  if (target.origin !== base.origin) {
    throw new Error("request blocked: cross-origin URL");
  }
  return target;
}

async function executeStep(
  page: Page,
  context: BrowserContext,
  step: TestStep,
  baseUrl: string,
  refs: Record<string, string>,
  runId: string,
  vars: Record<string, string>,
  secrets: string[],
  recordNetworkEntry: (input: DirectNetworkInput) => void,
) {
  const started = Date.now();
  try {
    switch (step.action) {
      case "navigate": {
        const path = step.path ?? "/";
        const url = path.startsWith("http") ? path : new URL(path, baseUrl).toString();
        if (!path.startsWith("http") && !baseUrl) {
          throw new Error("navigate requires baseUrl or absolute path");
        }
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: navTimeoutMs() });
        await page
          .waitForFunction("document.body && document.body.innerText.trim().length > 0", { timeout: 20_000 })
          .catch(() => undefined);
        break;
      }
      case "click": {
        if (!step.target) throw new Error("click requires target");
        const loc = await resolveStepLocator(page, step.target);
        await loc.click({ timeout: 15_000 });
        break;
      }
      case "fill": {
        if (!step.target) throw new Error("fill requires target");
        const raw = step.value ?? (step.valueRef ? refs[step.valueRef] : undefined);
        if (raw === undefined) throw new Error("fill requires value or resolvable valueRef");
        const value = raw.replace(/\{\{runId\}\}/g, runId);
        const loc = await resolveStepLocator(page, step.target);
        await loc.fill(value, { timeout: 15_000 });
        break;
      }
      case "select": {
        if (!step.target) throw new Error("select requires target");
        const raw = step.value ?? (step.valueRef ? refs[step.valueRef] : undefined);
        if (raw === undefined) throw new Error("select requires value or resolvable valueRef");
        const value = raw.replace(/\{\{runId\}\}/g, runId);
        const loc = await resolveStepLocator(page, step.target);
        await loc.selectOption(value, { timeout: 15_000 });
        break;
      }
      case "press": {
        if (!step.key) throw new Error("press requires key");
        await page.keyboard.press(step.key);
        break;
      }
      case "wait": {
        if (step.target) {
          await resolveStepLocator(page, step.target, 15_000);
        } else {
          await page.waitForLoadState("domcontentloaded");
          await page
            .waitForFunction("document.body && document.body.innerText.trim().length > 0", { timeout: 20_000 })
            .catch(() => undefined);
        }
        break;
      }
      case "selectCascader": {
        if (!step.target) throw new Error("selectCascader requires target");
        await executeSelectCascader(page, step, async () => {
          const loc = await resolveStepLocator(page, step.target!);
          await loc.click({ timeout: 15_000 });
        });
        break;
      }
      case "request": {
        if (!step.method) throw new Error("request requires method");
        if (step.body !== undefined && step.form !== undefined) {
          throw new Error("request accepts body or form, not both");
        }
        const rendered = renderRequestStep(step, {
          runId,
          vars,
          lookupEnv: lookupProcessEnv,
          secrets,
        });
        const target = resolveSameOriginRequestUrl(rendered.path, baseUrl);
        const response = await context.request.fetch(target.href, {
          method: step.method,
          headers: rendered.headers,
          ...(rendered.body !== undefined ? { data: rendered.body } : {}),
          ...(rendered.form !== undefined ? { form: rendered.form } : {}),
          maxRedirects: 0,
          failOnStatusCode: false,
          timeout: 15_000,
        });
        const responseText = await response.text();
        const requestBody = requestBodyForEvidence(rendered);
        recordNetworkEntry({
          url: redactSecretValues(target.href, secrets),
          method: step.method,
          status: response.status(),
          requestHeaders: redactSecretHeaderValues(rendered.headers, secrets),
          requestBody: requestBody === undefined ? undefined : redactSecretValues(requestBody, secrets),
          responseHeaders: redactSecretHeaderValues(response.headers(), secrets),
          responseBody: redactSecretValues(responseText, secrets),
        });
        assignResponseVariables(step, responseText, vars);
        break;
      }
      default:
        throw new Error(`unknown action: ${(step as TestStep).action}`);
    }
    return { stepId: step.id, status: "passed" as const, durationMs: Date.now() - started };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return {
      stepId: step.id,
      status: "failed" as const,
      durationMs: Date.now() - started,
      message: redactSecretValues(raw, secrets),
    };
  }
}

export async function runTestIR(ir: TestIR, options: RunOptions): Promise<RunResult> {
  const maxAttempts = maxRunAttempts(ir.policy?.retry);
  let last: RunResult | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await runTestIROnce(ir, {
      ...options,
      runId: attempt === 1 ? options.runId : `${options.runId ?? `run_${Date.now()}`}_r${attempt}`,
    });
    last.metrics.attemptCount = attempt;
    if (last.status === "passed") {
      if (attempt > 1) last.metrics.flakeRecovery = true;
      return last;
    }
    if (attempt >= maxAttempts || !shouldRetryAfterFailure(last, ir.policy?.retry)) return last;
  }
  return last!;
}

async function runTestIROnce(ir: TestIR, options: RunOptions): Promise<RunResult> {
  const wallStart = Date.now();
  const runId = options.runId ?? `run_${Date.now()}`;
  const startedAt = new Date().toISOString();
  const baseUrl = resolveBaseUrl(ir, options.env);
  const refs = resolveValueRefs(ir, options.env);
  resolveFixtureRefs(ir.fixture, options.env);

  const evidence = createEvidenceCollector({
    runId,
    dir: options.artifactsDir ?? "artifacts",
    screenshots: ir.policy?.screenshots ?? "on-failure",
  });

  let browser: Browser | undefined;
  const steps: StepResult[] = [];
  const assertionResults: Awaited<ReturnType<typeof runAssertion>>[] = [];
  let finalSignals: string[] | undefined;
  let status: RunStatus = "passed";

  try {
    browser = await chromium.launch({ headless: options.headless ?? true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await evidence.attachPage(context, page);
    const vars: Record<string, string> = {};
    const templateSecrets: string[] = [];

    for (const step of ir.steps) {
      const result = await executeStep(
        page,
        context,
        step,
        baseUrl,
        refs,
        runId,
        vars,
        templateSecrets,
        evidence.recordNetworkEntry,
      );
      steps.push(result);
      if (result.status === "failed") {
        status = "failed";
        await evidence.captureFailure(page, result.stepId);
        break;
      }
    }

    if (status === "passed") {
      if (ir.assertions.some((a) => a.type === "api")) {
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
        for (const assertion of ir.assertions) {
          if (assertion.type !== "api" || !assertion.requestRef) continue;
          const spec = resolveRequestRef(assertion.requestRef, options.env);
          if (!spec) continue;
          const expect = (assertion.expect ?? {}) as Record<string, unknown>;
          const expectsAbsence = expect.absent === true || expect.requestCount === 0;
          // A click can dispatch its request after networkidle already settled.
          await evidence.waitForNetworkEntry(
            (entry) =>
              urlPathMatches(entry.url, spec.urlIncludes) &&
              (!spec.method || entry.method.toUpperCase() === spec.method.toUpperCase()),
            expectsAbsence ? 1_500 : 10_000,
          );
        }
      }
      await evidence.waitForNetworkCapture();
      const networkLog = evidence.getNetworkLog();
      finalSignals = await captureFinalSignals(page);
      const dbClient = buildReadonlyDbClient(options.env);
      const traceClient = buildAgentTraceClient(options.env);
      const assertionCtx = {
        page,
        runId,
        network: networkLog,
        resolveRequestRef: (ref: string) => resolveRequestRef(ref, options.env),
        db: dbClient,
        resolveDbConfig: (ref: string) => getDbConfigBundle(ref),
        traces: traceClient,
        resolveAgentConfig: (ref: string) => getAgentConfigBundle(ref),
      };
      for (const assertion of ir.assertions) {
        const outcome = redactAssertionForEvidence(await runAssertion(assertion, assertionCtx));
        assertionResults.push(outcome);
        if (!outcome.passed) {
          status = "failed";
          await evidence.captureFailure(page, outcome.assertionId);
        }
      }
    }

    const artifacts = await evidence.finalize(status);
    const failedAssertion = assertionResults.find((a) => !a.passed);
    const failMsg = steps.find((s) => s.message)?.message ?? failedAssertion?.message;
    const failureKind =
      status === "passed"
        ? undefined
        : failedAssertion?.errorKind ??
          classifyFailure({ stepError: failMsg, assertionMessage: failedAssertion?.message ?? failMsg });
    return {
      runId,
      testId: ir.id,
      testVersion: ir.version,
      status,
      startedAt,
      completedAt: new Date().toISOString(),
      steps,
      assertions: assertionResults,
      artifacts,
      metrics: {
        durationMs: Date.now() - wallStart,
        llmTokensUsed: 0,
        failureKind,
        attemptCount: 1,
      },
      finalSignals,
    };
  } catch (err) {
    status = "error";
    const artifacts = await evidence.finalize(status);
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      runId,
      testId: ir.id,
      testVersion: ir.version,
      status,
      startedAt,
      completedAt: new Date().toISOString(),
      steps,
      assertions: assertionResults,
      artifacts: {
        ...artifacts,
        notes: errMsg,
      },
      metrics: {
        durationMs: Date.now() - wallStart,
        llmTokensUsed: 0,
        failureKind: classifyFailure({ stepError: errMsg }),
        attemptCount: 1,
      },
    };
  } finally {
    await browser?.close();
  }
}

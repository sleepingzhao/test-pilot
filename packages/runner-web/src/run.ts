import { join } from "node:path";
import { requestPathIssue, type Locator as TargetLocator, type TestActor, type TestIR, type TestStep } from "@testpilot/test-ir";
import { runAssertion, urlPathMatches, type AssertionContext } from "@testpilot/assertions";
import type { DirectNetworkInput, NetworkEntry, RunArtifacts, WsFrame } from "@testpilot/evidence";
import { classifyFailure, createEvidenceCollector, maxRunAttempts, redactForEvidence, redactStringBody, redactStrings, shouldRetryAfterFailure } from "@testpilot/evidence";
import type { RunEnvironment } from "@testpilot/fixtures";
import { buildReadonlyDbClient, buildAgentTraceClient, getDbConfigBundle, getAgentConfigBundle, resolveBaseUrl, resolveFixtureRefs, resolveRequestRef, resolveUploadFixturePath, resolveValueRefs } from "@testpilot/fixtures";
import { executeSelectCascader } from "./select-cascader.js";
import {
  assignResponseVariables,
  lookupProcessEnv,
  redactSecretValues,
  renderRequestStep,
  requestBodyForEvidence,
} from "./request-template.js";
import { chromium, type Browser, type BrowserContext, type FrameLocator, type Locator as PwLocator, type Page } from "playwright";

export type RunStatus = "passed" | "failed" | "error";

export type StepResult = {
  stepId: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  message?: string;
  /** Basename of step screenshot when policy.screenshots is "always". */
  screenshot?: string;
  /** Set when the step ran on a non-primary actor context. */
  actor?: string;
};

export type CleanupResult = {
  status: "passed" | "failed" | "skipped";
  steps: StepResult[];
  message?: string;
  errorKind?: string;
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
  /** `multi` when the IR lists 2+ actors; `single` is the explicit single-actor fallback. */
  actorMode?: "multi" | "single";
  /** Set when `readOnlyNetwork` blocked mutating traffic against a real target. */
  readOnly?: boolean;
  /** Real-target evidence policy applied: no screenshots/trace, payloads omitted on disk. */
  realTarget?: boolean;
  /** Browser requests aborted by the read-only route guard (UI-triggered writes). */
  readOnlyBlockedRequests?: number;
  /** Visible success/alerts right after the steps; used to derive a real success assertion. */
  finalSignals?: string[];
  cleanup?: CleanupResult;
};

export type RunOptions = {
  runId?: string;
  headless?: boolean;
  artifactsDir?: string;
  env: RunEnvironment;
  /**
   * Optional pre-step login (e.g. real-environment SSO). Runs once per actor
   * context before that actor's login steps and the main steps, with the
   * actor's credential account (defaults to primary).
   */
  login?: (
    page: Page,
    context: BrowserContext,
    baseUrl: string,
    account?: "primary" | "alt",
  ) => Promise<void>;
  /**
   * Real-environment run: forces no screenshots/trace and redacts network/WS/SSE
   * payloads on disk (assertions still see live in-memory data).
   */
  realTarget?: boolean;
  /**
   * Blocks mutating HTTP (via route), upload steps, non-GET request steps, and WebSocket sends.
   * Install only after the login hook and actor login steps so SSO form POST can complete.
   */
  readOnlyNetwork?: boolean;
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

type LocatorRoot = Page | FrameLocator;

function locatorCandidates(root: LocatorRoot, target: TargetLocator): PwLocator[] {
  const out: PwLocator[] = [];
  if (target.testId) out.push(root.getByTestId(target.testId));
  if (target.role) {
    out.push(
      target.name
        ? root.getByRole(target.role as Parameters<Page["getByRole"]>[0], { name: target.name, exact: true })
        : root.getByRole(target.role as Parameters<Page["getByRole"]>[0]),
    );
    if (target.name) {
      out.push(root.getByText(target.name, { exact: false }));
    }
  } else if (target.name) {
    out.push(root.getByText(target.name, { exact: false }));
  }
  if (target.label) out.push(root.getByLabel(target.label));
  if (target.placeholder) out.push(root.getByPlaceholder(target.placeholder));
  if (target.css) out.push(root.locator(target.css));
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

async function resolveStepLocator(root: LocatorRoot, target: TargetLocator, timeoutMs = 4_000) {
  const candidates = locatorCandidates(root, target);
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

type ExecuteStepOptions = {
  failOnHttpError?: boolean;
};

async function executeStep(
  page: Page,
  context: BrowserContext,
  step: TestStep,
  baseUrl: string,
  refs: Record<string, string>,
  env: RunEnvironment,
  runId: string,
  vars: Record<string, string>,
  secrets: string[],
  recordNetworkEntry: (input: DirectNetworkInput) => void,
  options?: ExecuteStepOptions,
): Promise<StepResult> {
  const started = Date.now();
  const root: LocatorRoot = step.frame ? page.frameLocator(step.frame) : page;
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
        const loc = await resolveStepLocator(root, step.target);
        await loc.click({ timeout: 15_000 });
        break;
      }
      case "fill": {
        if (!step.target) throw new Error("fill requires target");
        const raw = step.value ?? (step.valueRef ? refs[step.valueRef] : undefined);
        if (raw === undefined) throw new Error("fill requires value or resolvable valueRef");
        const value = raw.replace(/\{\{runId\}\}/g, runId);
        const loc = await resolveStepLocator(root, step.target);
        await loc.fill(value, { timeout: 15_000 });
        break;
      }
      case "select": {
        if (!step.target) throw new Error("select requires target");
        const raw = step.value ?? (step.valueRef ? refs[step.valueRef] : undefined);
        if (raw === undefined) throw new Error("select requires value or resolvable valueRef");
        const value = raw.replace(/\{\{runId\}\}/g, runId);
        const loc = await resolveStepLocator(root, step.target);
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
          await resolveStepLocator(root, step.target, 15_000);
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
          const loc = await resolveStepLocator(root, step.target!);
          await loc.click({ timeout: 15_000 });
        });
        break;
      }
      case "upload": {
        if (!step.target) throw new Error("upload step requires target");
        if (!step.valueRef) throw new Error("upload step requires valueRef");
        if (step.value !== undefined) {
          throw new Error("upload step must not store a file path in value; resolve it from valueRef");
        }
        const filePath = resolveUploadFixturePath(step.valueRef, refs, env);
        const loc = await resolveStepLocator(root, step.target);
        await loc.setInputFiles(filePath, { timeout: 15_000 });
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
          stepId: step.id,
          requestHeaders: redactSecretHeaderValues(rendered.headers, secrets),
          requestBody: requestBody === undefined ? undefined : redactSecretValues(requestBody, secrets),
          responseHeaders: redactSecretHeaderValues(response.headers(), secrets),
          responseBody: redactSecretValues(responseText, secrets),
        });
        assignResponseVariables(step, responseText, vars);
        const statusCode = response.status();
        if (options?.failOnHttpError && statusCode >= 400) {
          return {
            stepId: step.id,
            status: "failed" as const,
            durationMs: Date.now() - started,
            message: redactSecretValues(`request failed with HTTP ${statusCode}`, secrets),
          };
        }
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

function browserUsable(browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined): boolean {
  try {
    return Boolean(browser?.isConnected() && context && page && !page.isClosed());
  } catch {
    return false;
  }
}

function shouldRunTeardown(ir: TestIR, primaryStatus: RunStatus): boolean {
  const mode = ir.policy?.cleanup;
  if (!mode || mode === "none") return false;
  if (!ir.teardownSteps?.length) return false;
  if (mode === "on-success") return primaryStatus === "passed";
  return true;
}

function classifyCleanupFailure(messages: string[]): { errorKind: string; message: string } {
  const combined = messages.filter(Boolean).join("; ") || "teardown step failed";
  const blockedByReadOnly = messages.some((m) => m.startsWith("只读模式："));
  const kind = classifyFailure({ stepError: combined });
  const errorKind = blockedByReadOnly || kind === "ENVIRONMENT" ? "ENVIRONMENT" : "TEST_DATA";
  return { errorKind, message: `cleanup failed: ${combined}` };
}

function buildSkippedCleanup(ir: TestIR, primaryStatus: RunStatus): CleanupResult | undefined {
  const mode = ir.policy?.cleanup;
  if (!mode && !ir.teardownSteps?.length) return undefined;
  if (mode === "none") {
    return { status: "skipped", steps: [], message: "cleanup skipped: policy is none" };
  }
  if (mode === "on-success" && primaryStatus !== "passed") {
    return { status: "skipped", steps: [], message: "cleanup skipped: run did not pass (on-success)" };
  }
  if (!ir.teardownSteps?.length) return undefined;
  return undefined;
}

async function runTeardown(
  ir: TestIR,
  page: Page,
  context: BrowserContext,
  baseUrl: string,
  refs: Record<string, string>,
  env: RunEnvironment,
  runId: string,
  vars: Record<string, string>,
  secrets: string[],
  recordNetworkEntry: (input: DirectNetworkInput) => void,
  readOnlyNetwork?: boolean,
): Promise<CleanupResult> {
  const steps: StepResult[] = [];
  for (const step of ir.teardownSteps ?? []) {
    const blocked = readOnlyNetwork ? readOnlyBlockedMessage(step) : undefined;
    if (blocked) {
      steps.push({ stepId: step.id, status: "failed", durationMs: 0, message: blocked });
      continue;
    }
    const result = await executeStep(
      page,
      context,
      step,
      baseUrl,
      refs,
      env,
      runId,
      vars,
      secrets,
      recordNetworkEntry,
      { failOnHttpError: true },
    );
    steps.push(result);
  }
  const failed = steps.filter((s) => s.status === "failed");
  if (failed.length === 0) {
    return { status: "passed", steps };
  }
  const { errorKind, message } = classifyCleanupFailure(failed.map((s) => s.message ?? s.stepId));
  return { status: "failed", steps, message, errorKind };
}

function mergeFailureKind(
  primaryStatus: RunStatus,
  primaryKind: string | undefined,
  cleanup: CleanupResult | undefined,
): string | undefined {
  if (primaryStatus === "passed" && cleanup?.status === "failed") {
    return cleanup.errorKind ?? "TEST_DATA";
  }
  if (primaryStatus !== "passed") {
    return primaryKind;
  }
  return undefined;
}

function mergeRunStatus(primaryStatus: RunStatus, cleanup: CleanupResult | undefined): RunStatus {
  if (primaryStatus === "passed" && cleanup?.status === "failed") return "failed";
  return primaryStatus;
}

type ResolvedActor = {
  id: string;
  loginSteps: TestStep[];
  baseUrl?: string;
  baseUrlRef?: string;
  account?: "primary" | "alt";
};

function resolveActorDefinitions(ir: TestIR): ResolvedActor[] {
  if (!ir.actors?.length) {
    return [{ id: "primary", loginSteps: [] }];
  }
  const primaryEntry = ir.actors.find((a) => a.id === "primary");
  const primary: ResolvedActor = {
    id: "primary",
    loginSteps: primaryEntry?.loginSteps ?? [],
    baseUrl: primaryEntry?.baseUrl ?? ir.baseUrl,
    baseUrlRef: primaryEntry?.baseUrlRef ?? ir.baseUrlRef,
    ...(primaryEntry?.account ? { account: primaryEntry.account } : {}),
  };
  const others = ir.actors.filter((a) => a.id !== "primary").map((a) => ({
    id: a.id,
    loginSteps: a.loginSteps ?? [],
    baseUrl: a.baseUrl,
    baseUrlRef: a.baseUrlRef,
    ...(a.account ? { account: a.account } : {}),
  }));
  return [primary, ...others];
}

function resolveActorBaseUrl(actor: Pick<TestActor, "baseUrl" | "baseUrlRef">, ir: TestIR, env: RunEnvironment): string {
  if (actor.baseUrl) return actor.baseUrl;
  if (actor.baseUrlRef && env.baseUrlRefs?.[actor.baseUrlRef]) {
    return env.baseUrlRefs[actor.baseUrlRef];
  }
  return resolveBaseUrl(ir, env);
}

function actorModeForIr(ir: TestIR): "multi" | "single" {
  return ir.actors && ir.actors.length >= 2 ? "multi" : "single";
}

type ActorSession = {
  id: string;
  context: BrowserContext;
  page: Page;
  baseUrl: string;
  evidence: ReturnType<typeof createEvidenceCollector>;
};

function lookupActorSession(sessions: Map<string, ActorSession>, actorId: string): ActorSession | undefined {
  return sessions.get(actorId);
}

const READ_ONLY_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isReadOnlySafeRequestMethod(method: string | undefined): boolean {
  if (!method) return false;
  return method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD";
}

function isReadOnlyPolicyBlock(message?: string): boolean {
  if (!message) return false;
  return message.startsWith("只读模式：") || /read-only:\s*websocket send blocked/i.test(message);
}

function readOnlyBlockedMessage(step: TestStep): string | undefined {
  if (step.action === "upload") return "只读模式：已阻止文件上传";
  if (step.action === "request" && step.method && !isReadOnlySafeRequestMethod(step.method)) {
    return `只读模式：已阻止写请求 ${step.method} ${step.path ?? "/"}`;
  }
  return undefined;
}

type ReadOnlyGuardStats = { blockedRequests: number };

function applyReadOnlyWebSocketGuardInPage(): void {
  const g = globalThis as typeof globalThis & { __testpilotReadOnlyWs?: boolean };
  if (g.__testpilotReadOnlyWs) return;
  g.__testpilotReadOnlyWs = true;
  WebSocket.prototype.send = function () {
    console.info("[testpilot] read-only mode: WebSocket send blocked");
    throw new Error("read-only: websocket send blocked");
  };
}

/**
 * Real-environment read-only guard: abort non-safe HTTP in the browser and block WS sends.
 * Must run after login (which may need form POST) and before test steps.
 */
async function installReadOnlyNetworkGuard(
  context: BrowserContext,
  page: Page,
  stats?: ReadOnlyGuardStats,
): Promise<void> {
  await context.route("**/*", (route) => {
    const method = route.request().method().toUpperCase();
    if (READ_ONLY_HTTP_METHODS.has(method)) {
      void route.continue();
      return;
    }
    if (stats) stats.blockedRequests += 1;
    void route.abort("blockedbyclient");
  });
  await context.addInitScript(applyReadOnlyWebSocketGuardInPage);
  await page.evaluate(applyReadOnlyWebSocketGuardInPage);
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

async function runMainStep(
  ir: TestIR,
  step: TestStep,
  sessions: Map<string, ActorSession>,
  steps: StepResult[],
  refs: Record<string, string>,
  env: RunEnvironment,
  runId: string,
  vars: Record<string, string>,
  templateSecrets: string[],
  readOnlyNetwork?: boolean,
): Promise<StepResult> {
  const actorId = step.actor ?? "primary";
  const session = lookupActorSession(sessions, actorId);
  if (!session) {
    return {
      stepId: step.id,
      status: "failed",
      durationMs: 0,
      message: `unknown actor: ${actorId}`,
      ...(actorId !== "primary" ? { actor: actorId } : {}),
    };
  }
  if (step.action === "waitForEvent") {
    const spec = step.waitForEvent;
    const actorField = actorId !== "primary" ? { actor: actorId } : {};
    if (!spec) {
      return {
        stepId: step.id,
        status: "failed",
        durationMs: 0,
        message: "waitForEvent 缺少匹配条件",
        ...actorField,
      };
    }
    const timeoutMs = Math.min(Math.max(spec.timeoutMs ?? 10_000, 1_000), 60_000);
    const started = Date.now();
    const deadline = started + timeoutMs;
    let matched: "ws" | "sse" | undefined;
    while (!matched && Date.now() < deadline) {
      const frame = session.evidence.getWebSocketFrames().find(
        (item) =>
          (!spec.direction || item.direction === spec.direction) &&
          (!spec.contains || item.payload.includes(spec.contains)) &&
          (!spec.urlIncludes || item.url.includes(spec.urlIncludes)),
      );
      if (frame) {
        matched = "ws";
        break;
      }
      const sse = session.evidence
        .getSseEvents()
        .find(
          (event) =>
            (!spec.direction || spec.direction !== "sent") &&
            (!spec.contains || event.data.includes(spec.contains)) &&
            (!spec.urlIncludes || event.url.includes(spec.urlIncludes)),
        );
      if (sse) {
        matched = "sse";
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (matched) {
      return { stepId: step.id, status: "passed", durationMs: Date.now() - started, ...actorField };
    }
    return {
      stepId: step.id,
      status: "failed",
      durationMs: Date.now() - started,
      message: `waitForEvent timeout：未在 ${timeoutMs}ms 内观察到事件`,
      ...actorField,
    };
  }
  if (readOnlyNetwork) {
    const blocked = readOnlyBlockedMessage(step);
    if (blocked) {
      return {
        stepId: step.id,
        status: "failed",
        durationMs: 0,
        message: blocked,
        ...(actorId !== "primary" ? { actor: actorId } : {}),
      };
    }
  }
  const { page, context, baseUrl, evidence } = session;
  const executed = await executeStep(
    page,
    context,
    step,
    baseUrl,
    refs,
    env,
    runId,
    vars,
    templateSecrets,
    evidence.recordNetworkEntry,
  );
  const result: StepResult = { ...executed };
  if (actorId !== "primary") result.actor = actorId;
  if (result.status !== "failed" && step.saveFromRef && step.saveFields) {
    try {
      const spec = resolveRequestRef(step.saveFromRef, env);
      if (!spec) throw new Error(`unknown requestRef: ${step.saveFromRef}`);
      const matches = (entry: NetworkEntry) =>
        urlPathMatches(entry.url, spec.urlIncludes) &&
        (!spec.method || entry.method.toUpperCase() === spec.method.toUpperCase());
      const captured = await evidence.waitForNetworkEntry(matches, 10_000);
      if (!captured) throw new Error(`没有捕获到 ${step.saveFromRef} 的响应`);
      const entries = evidence.getNetworkLog().filter(matches);
      const entry = entries[entries.length - 1];
      if (!entry?.responseBody) {
        throw new Error(`${step.saveFromRef} 的响应体为空或过大，无法保存字段`);
      }
      assignResponseVariables(step, entry.responseBody, vars);
    } catch (err) {
      result.status = "failed";
      result.message = err instanceof Error ? err.message : String(err);
    }
  }
  if (result.status !== "failed" && (ir.policy?.screenshots ?? "on-failure") === "always") {
    const shot = await evidence.captureStep(page, result.stepId, steps.length + 1);
    // Only primary screenshots are addressable through the run artifact URL today.
    if (shot && actorId === "primary") result.screenshot = shot;
  }
  return result;
}

async function runTestIROnce(ir: TestIR, options: RunOptions): Promise<RunResult> {
  const wallStart = Date.now();
  const runId = options.runId ?? `run_${Date.now()}`;
  const startedAt = new Date().toISOString();
  const actorMode = actorModeForIr(ir);
  const refs = resolveValueRefs(ir, options.env);
  resolveFixtureRefs(ir.fixture, options.env);

  const artifactsRoot = options.artifactsDir ?? "artifacts";
  const screenshotPolicy = options.realTarget ? "never" : (ir.policy?.screenshots ?? "on-failure");
  const actorDefs = resolveActorDefinitions(ir);

  let browser: Browser | undefined;
  const sessions = new Map<string, ActorSession>();
  const steps: StepResult[] = [];
  const assertionResults: Awaited<ReturnType<typeof runAssertion>>[] = [];
  let finalSignals: string[] | undefined;
  let status: RunStatus = "passed";
  let runNotes: string | undefined;
  let loginHookFailed = false;
  const readOnlyStats: ReadOnlyGuardStats | undefined = options.readOnlyNetwork
    ? { blockedRequests: 0 }
    : undefined;
  const vars: Record<string, string> = {};
  const templateSecrets: string[] = [];

  const primaryBaseUrl = resolveActorBaseUrl(
    { baseUrl: actorDefs[0]?.baseUrl ?? ir.baseUrl, baseUrlRef: actorDefs[0]?.baseUrlRef ?? ir.baseUrlRef },
    ir,
    options.env,
  );

  try {
    browser = await chromium.launch({ headless: options.headless ?? true });
    for (const def of actorDefs) {
      const baseUrl = resolveActorBaseUrl(def, ir, options.env);
      const context = await browser.newContext();
      const page = await context.newPage();
      const evidence =
        def.id === "primary"
          ? createEvidenceCollector({
              runId,
              dir: artifactsRoot,
              screenshots: screenshotPolicy,
              ...(options.realTarget ? { realTarget: true } : {}),
            })
          : createEvidenceCollector({
              runId: def.id,
              dir: join(artifactsRoot, runId, "actors"),
              screenshots: screenshotPolicy,
              ...(options.realTarget ? { realTarget: true } : {}),
            });
      await evidence.attachPage(context, page);
      sessions.set(def.id, { id: def.id, context, page, baseUrl, evidence });
    }

    const primarySession = sessions.get("primary")!;

    if (options.login) {
      const loginSecrets = [
        process.env.TESTPILOT_ENV_REAL_ENTERPRISE_ID,
        process.env.TESTPILOT_ENV_REAL_USER_ID,
        process.env.TESTPILOT_ENV_REAL_PASSWORD,
        process.env.TESTPILOT_ENV_REAL_ALT_ENTERPRISE_ID,
        process.env.TESTPILOT_ENV_REAL_ALT_USER_ID,
        process.env.TESTPILOT_ENV_REAL_ALT_PASSWORD,
        ...templateSecrets,
      ].filter((value): value is string => Boolean(value?.trim()));
      for (const def of actorDefs) {
        const session = sessions.get(def.id)!;
        try {
          await options.login(session.page, session.context, session.baseUrl, def.account ?? "primary");
        } catch (err) {
          status = "failed";
          loginHookFailed = true;
          const raw = err instanceof Error ? err.message : String(err);
          const label = actorDefs.length > 1 ? `（${def.id}）` : "";
          runNotes = `真实环境登录失败${label}: ${redactSecretValues(redactStringBody(raw), loginSecrets)}`;
          // Do not capture the login page: it may contain tenant/user fields or
          // typed credentials. Evidence policy for real targets is V7-12c.
          break;
        }
      }
    }

    if (status === "passed") {
    for (const def of actorDefs) {
      const session = sessions.get(def.id)!;
      for (const loginStep of def.loginSteps) {
        const executed = await executeStep(
          session.page,
          session.context,
          loginStep,
          session.baseUrl,
          refs,
          options.env,
          runId,
          vars,
          templateSecrets,
          session.evidence.recordNetworkEntry,
        );
        if (executed.status === "failed") {
          status = "failed";
          const loginResult: StepResult = {
            ...executed,
            message: `[actor:${def.id}] ${executed.message ?? "login step failed"}`,
            ...(def.id !== "primary" ? { actor: def.id } : {}),
          };
          steps.push(loginResult);
          await session.evidence.captureFailure(session.page, loginStep.id);
          break;
        }
      }
      if (status === "failed") break;
    }
    }

  // Login hook may POST credentials; actor loginSteps may POST too — guard applies to test steps only.
  if (status === "passed" && options.readOnlyNetwork) {
    for (const session of sessions.values()) {
      await installReadOnlyNetworkGuard(session.context, session.page, readOnlyStats);
    }
  }

    if (status === "passed") {
      for (const step of ir.steps) {
        const result = await runMainStep(
          ir,
          step,
          sessions,
          steps,
          refs,
          options.env,
          runId,
          vars,
          templateSecrets,
          options.readOnlyNetwork,
        );
        steps.push(result);
        if (result.status === "failed") {
          status = "failed";
          const failSession = lookupActorSession(sessions, step.actor ?? "primary") ?? primarySession;
          await failSession.evidence.captureFailure(failSession.page, result.stepId);
          break;
        }
      }
    }

    if (status === "passed") {
      if (ir.assertions.some((a) => a.type === "api")) {
        const apiActorIds = new Set(
          ir.assertions.filter((a) => a.type === "api").map((a) => a.actor ?? "primary"),
        );
        for (const actorId of apiActorIds) {
          const session = lookupActorSession(sessions, actorId);
          await session?.page
            .waitForLoadState("networkidle", { timeout: 8_000 })
            .catch(() => undefined);
        }
        for (const assertion of ir.assertions) {
          if (assertion.type !== "api" || !assertion.requestRef) continue;
          const actorId = assertion.actor ?? "primary";
          const session = lookupActorSession(sessions, actorId);
          if (!session) continue;
          const spec = resolveRequestRef(assertion.requestRef, options.env);
          if (!spec) continue;
          const expect = (assertion.expect ?? {}) as Record<string, unknown>;
          const expectsAbsence = expect.absent === true || expect.requestCount === 0;
          await session.evidence.waitForNetworkEntry(
            (entry) =>
              urlPathMatches(entry.url, spec.urlIncludes) &&
              (!spec.method || entry.method.toUpperCase() === spec.method.toUpperCase()),
            expectsAbsence ? 1_500 : 10_000,
          );
        }
      }
      for (const session of sessions.values()) {
        await session.evidence.waitForNetworkCapture();
      }
      finalSignals = await captureFinalSignals(primarySession.page);
      const dbClient = buildReadonlyDbClient(options.env);
      const traceClient = buildAgentTraceClient(options.env);
      for (const assertion of ir.assertions) {
        const actorId = assertion.actor ?? "primary";
        const session = lookupActorSession(sessions, actorId);
        if (!session) {
          const outcome = {
            assertionId: assertion.id ?? "assertion",
            passed: false,
            message: `unknown actor: ${actorId}`,
            errorKind: "ASSERTION_ORACLE",
          } as Awaited<ReturnType<typeof runAssertion>>;
          assertionResults.push(outcome);
          status = "failed";
          continue;
        }
        const networkLog = session.evidence.getNetworkLog();
        const assertionCtx: AssertionContext = {
          page: session.page,
          ...(assertion.frame ? { frame: assertion.frame } : {}),
          runId,
          network: networkLog,
          wsFrames: session.evidence.getWebSocketFrames(),
          waitForWsFrames: async (predicate: (frame: WsFrame) => boolean, timeoutMs: number) => {
            const ok = await session.evidence.waitForWebSocketFrame((frame) => {
              assertionCtx.wsFrames = session.evidence.getWebSocketFrames();
              return predicate(frame);
            }, timeoutMs);
            assertionCtx.wsFrames = session.evidence.getWebSocketFrames();
            return ok;
          },
          resolveRequestRef: (ref: string) => resolveRequestRef(ref, options.env),
          db: dbClient,
          resolveDbConfig: (ref: string) => getDbConfigBundle(ref),
          traces: traceClient,
          resolveAgentConfig: (ref: string) => getAgentConfigBundle(ref),
        };
        const outcome = redactAssertionForEvidence(await runAssertion(assertion, assertionCtx));
        assertionResults.push(outcome);
        if (!outcome.passed) {
          status = "failed";
          await session.evidence.captureFailure(session.page, outcome.assertionId);
        }
      }
    }
  } catch (err) {
    status = "error";
    runNotes = err instanceof Error ? err.message : String(err);
  }

  const primarySession = sessions.get("primary");
  let cleanup: CleanupResult | undefined;
  const primaryStatusBeforeCleanup = status;
  if (shouldRunTeardown(ir, primaryStatusBeforeCleanup)) {
    if (browserUsable(browser, primarySession?.context, primarySession?.page)) {
      cleanup = await runTeardown(
        ir,
        primarySession!.page,
        primarySession!.context,
        primaryBaseUrl,
        refs,
        options.env,
        runId,
        vars,
        templateSecrets,
        primarySession!.evidence.recordNetworkEntry,
        options.readOnlyNetwork,
      );
    } else {
      cleanup = {
        status: "failed",
        steps: [],
        message: "cleanup failed: browser or page is not available",
        errorKind: "ENVIRONMENT",
      };
    }
  } else {
    cleanup = buildSkippedCleanup(ir, primaryStatusBeforeCleanup);
  }

  status = mergeRunStatus(status, cleanup);
  const failedAssertion = assertionResults.find((a) => !a.passed);
  const failMsg = steps.find((s) => s.message)?.message ?? failedAssertion?.message;
  const readOnlyStepBlocked = steps.some((s) => s.status === "failed" && isReadOnlyPolicyBlock(s.message));
  const readOnlyBlockedRequests = readOnlyStats?.blockedRequests ?? 0;
  const primaryFailureKind =
    primaryStatusBeforeCleanup === "passed"
      ? undefined
      : loginHookFailed || readOnlyStepBlocked || readOnlyBlockedRequests > 0
        ? "ENVIRONMENT"
        : failedAssertion?.errorKind ??
          classifyFailure({
            stepError: runNotes ?? failMsg,
            assertionMessage: failedAssertion?.message ?? failMsg,
          });
  const failureKind = mergeFailureKind(primaryStatusBeforeCleanup, primaryFailureKind, cleanup);
  if (status !== "passed" && readOnlyBlockedRequests > 0) {
    const note = `只读模式：已阻止 ${readOnlyBlockedRequests} 个写请求，断言结果可能受此影响`;
    runNotes = runNotes ? `${runNotes}; ${note}` : note;
  }

  try {
    const primaryEvidence = primarySession?.evidence ?? sessions.values().next().value?.evidence;
    const artifacts = primaryEvidence ? await primaryEvidence.finalize(status) : { runId, dir: join(artifactsRoot, runId), artifacts: [] };
    for (const session of sessions.values()) {
      if (session.id === "primary") continue;
      const actorArtifacts = await session.evidence.finalize(status);
      artifacts.artifacts.push(...actorArtifacts.artifacts);
    }
    return {
      runId,
      testId: ir.id,
      testVersion: ir.version,
      status,
      startedAt,
      completedAt: new Date().toISOString(),
      steps,
      assertions: assertionResults,
      artifacts: runNotes ? { ...artifacts, notes: runNotes } : artifacts,
      metrics: {
        durationMs: Date.now() - wallStart,
        llmTokensUsed: 0,
        failureKind,
        attemptCount: 1,
      },
      actorMode,
      ...(options.readOnlyNetwork ? { readOnly: true } : {}),
      ...(options.realTarget ? { realTarget: true } : {}),
      ...(readOnlyBlockedRequests > 0 ? { readOnlyBlockedRequests } : {}),
      finalSignals,
      cleanup,
    };
  } finally {
    await browser?.close();
  }
}

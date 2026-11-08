import type { FastifyInstance } from "fastify";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { assertPlaywrightReady, recordSession } from "@testpilot/recorder-web";
import { runTestIR, type RunResult } from "@testpilot/runner-web";
import { snapshotPageContext } from "@testpilot/context-web";
import { draftToPartialIR, planDraft, planFromIntake, suggestAssertionsForTest, filterForbiddenSuggestionTokens } from "@testpilot/planner";
import {
  computeIRHash,
  IR_HASH_VERSION,
  validateSemantics,
  validateTestIR,
  weakAssertionIssues,
} from "@testpilot/test-ir";
import { validateAssertionProviders } from "@testpilot/assertions";
import { computeAssertionConfigHash } from "@testpilot/fixtures";
import { classifyFailure, redactForEvidence, redactStringBody } from "@testpilot/evidence";
import { chromium } from "playwright";
import type { FileStore, RecordJob, StoredBatch, StoredRun, StoredTest } from "./store.js";
import { llmUsageSnapshot } from "./llm-usage.js";
import {
  applyOptionalLlmDraft,
  llmPlannerConfigFromEnv,
  llmPlannerPublicInfo,
  suggestDiagnoseWithLlm,
} from "./llm-planner.js";
import {
  resolveRequirementTargetUrl,
  mergeRequirementSteps,
  pickObservedSuccessSignal,
  type RequirementTarget,
} from "./requirement-target.js";
import { pilotLoginSteps } from "./bootstrap-pilot-intakes.js";
import { readNegativeProbeReport } from "./negative-probes.js";
import { resolveApprovalActor, approvalIdentityPublicInfo } from "./approval-identity.js";
import { appendAuditEvent, readAuditLog } from "./audit-log.js";
import { buildFlakeMetricsReport, computeFlakeStats, normalizeRepeatCount } from "./flake-metrics.js";
import {
  assertionConfigCatalog,
  assertionProviderCatalog,
  previewProviderAssertion,
  testAssertionConnection,
  validateAssertionsDraft,
} from "./assertion-config.js";
import {
  applyBaseUrlTarget,
  buildRunEnvironment,
  isPilotTest,
  missingEnvRefs,
  pilotBaseUrl,
  pilotSecretsConfigured,
  realBaseUrl,
  realSecretsConfigured,
  uniqueTargetBaseUrls,
  absoluteStepUrls,
  DEMO_BASE_URL,
} from "./run-env.js";
import { metricsFromBatchRecord } from "./batch-metrics.js";
import { autoPruneArtifacts, measureBatchArtifactBytes } from "./artifact-cleanup.js";
import { createMutex, mapWithConcurrency, maxParallelFromEnv } from "./batch-parallel.js";
import { sessionArtifactsRunsDir, sessionIdForBatch, sessionIdForRun } from "./session-layout.js";
import {
  computeRegressionBaseline,
  writeRegressionBaselineReport,
} from "./regression-baseline.js";
import {
  isAllowedTargetUrl,
  isSafeArtifactName,
  isSafeRunId,
  isSafeTestId,
  isWithin,
  resolveWithin,
} from "./security.js";
import {
  capturePilotIntakeContext,
  isPilotIntakeUrl,
  looksLikeLoginPageContext,
} from "./pilot-intake-snapshot.js";
import {
  latestDetection,
  listDetections,
  readDetection,
  runDetection,
  type DetectionJob,
  type DetectionTarget,
} from "./detection.js";

const recordJobs = new Map<string, RecordJob>();
let recordLock = false;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

export type RunBatchJob = {
  id: string;
  batchId: string;
  status: "running" | "completed" | "failed";
  total: number;
  completed: number;
  currentTitle?: string;
  runs: StoredRun[];
  error?: string;
  startedAt: string;
  completedAt?: string;
};

const batchJobs = new Map<string, RunBatchJob>();

function stampTestMeta(test: StoredTest, opts?: { approving?: boolean; assertionConfigHash?: string }): StoredTest {
  const irHash = computeIRHash(test.ir);
  const next: StoredTest = { ...test, irHash, irHashVersion: IR_HASH_VERSION, updatedAt: new Date().toISOString() };
  if (opts?.approving) {
    next.approvalStatus = "approved";
    next.approvedAt = new Date().toISOString();
    if (opts.assertionConfigHash) next.assertionConfigHash = opts.assertionConfigHash;
  }
  return next;
}

function withWeakAssertions(test: StoredTest) {
  const currentConfigHash = computeAssertionConfigHash(repoRoot);
  return {
    ...test,
    weakAssertions: weakAssertionIssues(test.ir),
    currentAssertionConfigHash: currentConfigHash,
    configHashStale:
      test.approvalStatus === "approved" &&
      Boolean(test.assertionConfigHash) &&
      test.assertionConfigHash !== currentConfigHash,
  };
}

async function readLocalJson<T>(filename: string): Promise<T | null> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const primary = join(repoRoot, "docs", filename);
  const fallback = join(repoRoot, "docs", filename.replace(".json", ".example.json"));
  for (const path of [primary, fallback]) {
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function loadPilotConstraints(): Promise<{ scopeNotes: string[]; forbiddenAssertions: string[] } | null> {
  return readLocalJson("pilot-constraints.json");
}

function forbiddenAssertionIssues(
  ir: StoredTest["ir"],
  forbidden: string[],
): Array<{ path: string; message: string }> {
  if (!forbidden.length) return [];
  const issues: Array<{ path: string; message: string }> = [];
  for (const [i, a] of ir.assertions.entries()) {
    const text = String((a as { contains?: string }).contains ?? "");
    if (!text) continue;
    for (const token of forbidden) {
      const t = token.trim();
      if (!t) continue;
      if (text.toLowerCase().includes(t.toLowerCase())) {
        issues.push({
          path: `/assertions/${i}/contains`,
          message: `试点约束：断言不得包含「${t}」`,
        });
      }
    }
  }
  return issues;
}

function makeIntakeTestId(title: string): string {
  const suffix = `${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  return slug ? `intake-${slug}-${suffix}` : `intake-${suffix}`;
}

async function snapshotAtUrl(url: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    return await snapshotPageContext(page);
  } finally {
    await browser.close();
  }
}

async function loadPilotBaseline(): Promise<{
  manualRegressionMinutes?: number;
  notes?: string;
  baseUrl?: string;
  loginPath?: string;
  intakePath?: string;
} | null> {
  const doc = await readLocalJson<{
    manualRegressionMinutes?: number;
    notes?: string;
    baseUrl?: string;
    loginPath?: string;
    intakePath?: string;
  }>("pilot-baseline.json");
  if (!doc) return null;
  return {
    ...doc,
    baseUrl: process.env.TESTPILOT_PILOT_BASE_URL || doc.baseUrl,
  };
}

async function pilotIntakeDefaultUrl(): Promise<string> {
  const base = pilotBaseUrl();
  if (!base) return "";
  const baseline = await loadPilotBaseline();
  const path = baseline?.intakePath?.trim() || "/customer";
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${base.replace(/\/$/, "")}${normalized}`;
}

/** Runner should write network.json every run; patch if an old worker skipped it. */
async function ensureNetworkArtifact(artifacts: RunResult["artifacts"]): Promise<RunResult["artifacts"]> {
  const runDir = artifacts.dir;
  const netPath = join(runDir, "network.json");
  if (!existsSync(netPath)) {
    await mkdir(runDir, { recursive: true });
    await writeFile(netPath, "[]\n", "utf8");
  }
  if (artifacts.artifacts.some((a) => a.kind === "network")) {
    return artifacts;
  }
  return {
    ...artifacts,
    artifacts: [...artifacts.artifacts, { kind: "network", path: netPath }],
  };
}

async function checkTargetReachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function refreshRegressionBaselineReport(store: FileStore, dataRoot: string) {
  const batches = await store.listBatches(50);
  const runs = await store.listRuns(500);
  const byId = new Map(runs.map((r) => [r.runId, r]));
  const report = computeRegressionBaseline(batches, byId);
  await writeRegressionBaselineReport(dataRoot, report);
}

async function appendRunMetrics(dataRoot: string, stored: StoredRun, extra?: Record<string, unknown>) {
  await appendFile(
    join(dataRoot, "metrics.jsonl"),
    `${JSON.stringify({
      at: stored.completedAt,
      testId: stored.testId,
      status: stored.status,
      durationMs: stored.metrics?.durationMs,
      failureKind: stored.metrics?.failureKind,
      attemptCount: stored.metrics?.attemptCount ?? 1,
      flakeRecovery: stored.metrics?.flakeRecovery ?? false,
      batchId: stored.batchId,
      llmTokens: 0,
      ...extra,
    })}\n`,
  );
}

/** Old runs may predate write-time redaction; redact again on API reads. */
function redactRunForApi(run: StoredRun): StoredRun {
  return redactForEvidence(run) as StoredRun;
}

function artifactPresence(run: StoredRun, artifactsRoot: string): Record<string, boolean> {
  const root = resolve(artifactsRoot);
  const rawRunDir = run.artifacts?.dir ?? join(root, "runs", run.runId);
  const runDir = resolve(isAbsolute(rawRunDir) ? rawRunDir : resolve(root, "..", rawRunDir));
  const present: Record<string, boolean> = {};
  for (const artifact of run.artifacts?.artifacts ?? []) {
    const filePath = resolve(isAbsolute(artifact.path) ? artifact.path : join(runDir, artifact.path));
    if (isWithin(runDir, filePath)) present[artifact.kind] = existsSync(filePath);
  }
  if (present.network === undefined) present.network = existsSync(join(runDir, "network.json"));
  if (present.trace === undefined) present.trace = existsSync(join(runDir, "trace.zip"));
  return present;
}

function runTimeoutMs(): number {
  const raw = Number(process.env.TESTPILOT_RUN_TIMEOUT_MS ?? 180_000);
  if (!Number.isFinite(raw)) return 180_000;
  return Math.min(600_000, Math.max(30_000, raw));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function runSingleTest(
  store: FileStore,
  test: StoredTest,
  baseUrl: string,
  projectId: string,
  artifactsRoot: string,
  dataRoot: string,
  batch?: { batchId: string; batchStartedAt: string },
): Promise<StoredRun | null> {
  const runId = `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const sessionId = batch ? sessionIdForBatch(batch.batchId) : sessionIdForRun(runId);
  const artifactsDir = sessionArtifactsRunsDir(artifactsRoot, sessionId);
  try {
    const v = validateTestIR(test.ir);
    if (!v.ok) throw new Error(`IR 校验失败: ${v.issues.map((i) => i.message).join("; ")}`);
    const runEnv = buildRunEnvironment(baseUrl);
    const result = await withTimeout(
      runTestIR(v.value, {
        runId,
        headless: true,
        artifactsDir,
        env: runEnv,
      }),
      runTimeoutMs(),
      `run ${test.id}`,
    );
    const artifacts = await ensureNetworkArtifact(result.artifacts);
    const stored: StoredRun = {
      ...result,
      artifacts,
      projectId,
      testTitle: test.title,
      ...(batch ? { batchId: batch.batchId, batchStartedAt: batch.batchStartedAt } : {}),
    };
    await store.saveRun(stored);
    await appendRunMetrics(dataRoot, stored);
    return stored;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`run failed before completion: ${test.id}`, message);
    const completedAt = new Date().toISOString();
    const failed: StoredRun = {
      runId,
      testId: test.id,
      testVersion: test.ir.version,
      status: "error",
      startedAt,
      completedAt,
      steps: [{ stepId: "run", status: "failed", durationMs: Date.now() - startedMs, message }],
      assertions: [],
      artifacts: { runId, dir: join(artifactsDir, runId), artifacts: [] },
      metrics: {
        durationMs: Date.now() - startedMs,
        llmTokensUsed: 0,
        failureKind: classifyFailure({ stepError: message }),
        attemptCount: 1,
      },
      projectId,
      testTitle: test.title,
      ...(batch ? { batchId: batch.batchId, batchStartedAt: batch.batchStartedAt } : {}),
    };
    await store.saveRun(failed);
    await appendRunMetrics(dataRoot, failed);
    return failed;
  }
}

async function executeRuns(
  store: FileStore,
  tests: StoredTest[],
  baseUrl: string,
  projectId: string,
  artifactsRoot: string,
  dataRoot: string,
  job?: RunBatchJob,
): Promise<StoredRun[]> {
  const parallel = tests.length > 1 ? maxParallelFromEnv() : 1;
  const batchCtx =
    job != null ? { batchId: job.batchId, batchStartedAt: job.startedAt } : undefined;
  // One pilot account: concurrent logins race with each other and stall page loads.
  const pilotLock = createMutex();

  const outcomes = await mapWithConcurrency(tests, parallel, async (test) => {
    const execute = async () => {
      if (job) job.currentTitle = test.title;
      const stored = await runSingleTest(store, test, baseUrl, projectId, artifactsRoot, dataRoot, batchCtx);
      if (job) {
        job.completed += 1;
        if (stored) job.runs = [...job.runs, stored];
      }
      return stored;
    };
    return isPilotTest(test) ? pilotLock.run(execute) : execute();
  });

  return outcomes.filter((r): r is StoredRun => r != null);
}

/** One-paragraph requirements usually start with the behavior; use it as the title. */
export function titleFromRequirement(text: string): string {
  const first = text.split(/[\n。！？!?；;]/)[0]?.trim() ?? "";
  const withoutParenthetical = first.replace(/[（(][^）)]*[）)]/g, "").trim();
  return (withoutParenthetical || "需求草案").slice(0, 30);
}

/** Pilot ticket forms use the create request as the durable success oracle. */
export function resolveRequirementAssertions(
  usePilotOracle: boolean,
  fallback: StoredTest["ir"]["assertions"],
): StoredTest["ir"]["assertions"] {
  if (!usePilotOracle) return fallback;
  return [
    {
      id: "ticket-submit-api",
      type: "api",
      provider: "captured-http",
      requestRef: "pilot-ticket-submit",
      expect: { statusCode: 200, requestBodyContains: "TestPilot-" },
      oracle: "api-contract",
    },
  ];
}

/**
 * An unapproved draft's assertion is a guess. A miss proves the guess wrong at
 * least as often as it proves the product wrong, so never report PRODUCT_DEFECT
 * for it; the human still approves the assertion before regression.
 */
export function reclassifyDraftAssertionFailures(run: StoredRun, approved: boolean): StoredRun {
  if (approved) return run;
  const assertions = run.assertions.map((a) =>
    !a.passed && a.errorKind === "PRODUCT_DEFECT"
      ? { ...a, errorKind: "ASSERTION_ORACLE" as const }
      : a,
  );
  const failureKind =
    run.metrics?.failureKind === "PRODUCT_DEFECT" ? "ASSERTION_ORACLE" : run.metrics?.failureKind;
  return {
    ...run,
    assertions,
    metrics: { ...run.metrics, failureKind },
  };
}

async function executeSingleIrRun(
  store: FileStore,
  test: StoredTest,
  ir: StoredTest["ir"],
  baseUrl: string,
  projectId: string,
  artifactsRoot: string,
  dataRoot: string,
): Promise<StoredRun> {
  const v = validateTestIR(ir);
  if (!v.ok) {
    throw new Error(`IR 校验失败: ${v.issues.map((i) => i.message).join("; ")}`);
  }
  const runId = `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const runEnv = buildRunEnvironment(baseUrl);
  const result = await runTestIR(v.value, {
    runId,
    headless: true,
    artifactsDir: sessionArtifactsRunsDir(artifactsRoot, sessionIdForRun(runId)),
    env: runEnv,
  });
  const artifacts = await ensureNetworkArtifact(result.artifacts);
  const stored = reclassifyDraftAssertionFailures(
    {
      ...result,
      artifacts,
      projectId,
      testTitle: test.title,
      trial: true,
    },
    test.approvalStatus === "approved",
  );
  await store.saveRun(stored);
  await appendRunMetrics(dataRoot, stored, { trial: true });
  void autoPruneArtifacts({ artifactsRoot, dataRoot }).catch(() => undefined);
  return stored;
}

export function registerRoutes(app: FastifyInstance, store: FileStore, artifactsRoot: string, dataRoot: string) {
  app.get("/api/health", async () => ({
    ok: true,
    service: "test-management",
    version: "0.2.0",
    platforms: ["web"],
    upcoming: ["android", "ios", "harmony", "glass"],
  }));

  app.get("/api/projects", async () => [store.project()]);

  app.get("/api/projects/:projectId/tests", async () => (await store.listTests()).map(withWeakAssertions));

  app.get("/api/tests/:testId", async (req, reply) => {
    const { testId } = req.params as { testId: string };
    if (!isSafeTestId(testId)) return reply.notFound("test not found");
    const test = await store.getTest(testId);
    if (!test) return reply.notFound("test not found");
    return withWeakAssertions(test);
  });

  app.put("/api/tests/:testId", async (req, reply) => {
    const { testId } = req.params as { testId: string };
    if (!isSafeTestId(testId)) return reply.notFound("test not found");
    const body = req.body as { title?: string; ir?: StoredTest["ir"]; intentSummary?: string };
    const existing = await store.getTest(testId);
    if (!existing) return reply.notFound("test not found");
    const updated = stampTestMeta({
      ...existing,
      title: body.title ?? existing.title,
      ir: body.ir ?? existing.ir,
      intentSummary: body.intentSummary ?? existing.intentSummary,
      approvalStatus: body.ir ? "draft" : existing.approvalStatus,
      updatedAt: existing.updatedAt,
    });
    const v = validateTestIR(updated.ir);
    if (!v.ok) return reply.code(400).send({ issues: v.issues });
    const providerIssues = validateAssertionProviders(updated.ir);
    if (providerIssues.length) {
      return reply.code(400).send({ issues: providerIssues, error: "断言 Provider 校验失败" });
    }
    await store.saveTest(updated);
    return withWeakAssertions(updated);
  });

  app.delete("/api/tests/:testId", async (req, reply) => {
    const { testId } = req.params as { testId: string };
    if (!isSafeTestId(testId)) return reply.notFound("test not found");
    await store.deleteTest(testId);
    return { ok: true };
  });

  app.post("/api/tests/:testId/trial-run", async (req, reply) => {
    const { testId } = req.params as { testId: string };
    if (!isSafeTestId(testId)) return reply.notFound("test not found");
    const test = await store.getTest(testId);
    if (!test) return reply.notFound("test not found");
    const body = (req.body ?? {}) as { ir?: StoredTest["ir"] };
    if (!body.ir) {
      return reply.code(400).send({ error: "试跑需要提交 ir 草稿" });
    }
    if (body.ir.id !== testId) {
      return reply.code(400).send({ error: "ir.id 必须与 testId 一致" });
    }
    const v = validateTestIR(body.ir);
    if (!v.ok) return reply.code(400).send({ issues: v.issues });
    const providerIssues = validateAssertionProviders(body.ir);
    if (providerIssues.length) {
      return reply.code(400).send({ issues: providerIssues, error: "断言 Provider 校验失败" });
    }
    const project = store.project();
    const runEnv = buildRunEnvironment(project.defaultBaseUrl);
    let targets: string[];
    try {
      targets = uniqueTargetBaseUrls([{ ...test, ir: body.ir }], runEnv);
    } catch (err) {
      return reply.code(503).send({ error: err instanceof Error ? err.message : String(err) });
    }
    for (const url of targets) {
      if (!isAllowedTargetUrl(url)) {
        return reply.code(400).send({ error: `用例目标地址不在允许列表: ${url}` });
      }
    }
    for (const url of absoluteStepUrls([{ ...test, ir: body.ir }])) {
      if (!isAllowedTargetUrl(url)) {
        return reply.code(400).send({ error: `步骤目标地址不在允许列表: ${url}` });
      }
    }
    const missingSecrets = missingEnvRefs(body.ir);
    if (missingSecrets.length) {
      return reply.code(503).send({
        error: `缺少用例所需环境变量：${missingSecrets.join(", ")}（见 .env.example）`,
      });
    }
    for (const url of targets) {
      if (!(await checkTargetReachable(url))) {
        return reply.code(503).send({ error: `目标环境不可达: ${url}` });
      }
    }
    try {
      const run = await executeSingleIrRun(
        store,
        test,
        body.ir,
        project.defaultBaseUrl,
        project.id,
        artifactsRoot,
        dataRoot,
      );
      return { run, trial: true };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/tests/:testId/approve", async (req, reply) => {
    const { testId } = req.params as { testId: string };
    if (!isSafeTestId(testId)) return reply.notFound("test not found");
    const test = await store.getTest(testId);
    if (!test) return reply.notFound("test not found");
    const body = (req.body ?? {}) as { irHash?: string; assertionConfigHash?: string };
    const currentHash = computeIRHash(test.ir);
    const currentConfigHash = computeAssertionConfigHash(repoRoot);
    if (!body.irHash) {
      return reply.code(400).send({
        error: "审批必须携带审阅时的 irHash",
        irHash: currentHash,
      });
    }
    if (body.irHash !== currentHash) {
      return reply.code(409).send({
        error: "用例内容已变化，请重新审阅后再批准",
        irHash: currentHash,
        assertionConfigHash: currentConfigHash,
      });
    }
    if (!body.assertionConfigHash) {
      return reply.code(400).send({
        error: "审批必须携带审阅时的 assertionConfigHash",
        assertionConfigHash: currentConfigHash,
      });
    }
    if (body.assertionConfigHash !== currentConfigHash) {
      return reply.code(409).send({
        error: "断言配置已变化，请重新审阅后再批准",
        assertionConfigHash: currentConfigHash,
      });
    }
    const hasPlaceholder = test.ir.assertions.some((a) =>
      String((a as { contains?: string }).contains ?? "").includes("REPLACE"),
    );
    if (hasPlaceholder) return reply.code(400).send({ error: "请先完善断言再批准" });
    if (!test.ir.steps?.length) {
      return reply.code(400).send({ error: "用例至少需要一个步骤；请录制或编辑 IR" });
    }
    const semantic = validateSemantics(test.ir);
    if (semantic.length) return reply.code(400).send({ issues: semantic });
    const weak = weakAssertionIssues(test.ir);
    if (weak.length) {
      return reply.code(400).send({
        error: "UI 断言过弱：请指定断言区域，或使用更具体的成功文案",
        issues: weak,
      });
    }
    const constraintsDoc = await loadPilotConstraints();
    const pilotForbidden = forbiddenAssertionIssues(test.ir, constraintsDoc?.forbiddenAssertions ?? []);
    if (pilotForbidden.length) {
      return reply.code(400).send({
        error: "断言违反试点约束，请修改后再批准",
        issues: pilotForbidden,
      });
    }
    const providerIssues = validateAssertionProviders(test.ir);
    if (providerIssues.length) {
      return reply.code(400).send({
        error: "断言 Provider 无效或未配置",
        issues: providerIssues,
      });
    }
    const actorResult = resolveApprovalActor(req);
    if (!actorResult.ok) {
      return reply.code(actorResult.statusCode).send({ error: actorResult.error });
    }
    const approved = {
      ...stampTestMeta(test, { approving: true, assertionConfigHash: currentConfigHash }),
      approvedBy: actorResult.actor,
      approvedIr: test.ir,
    };
    await store.saveTest(approved);
    try {
      await appendAuditEvent(dataRoot, {
        at: new Date().toISOString(),
        action: "test.approve",
        testId,
        title: test.title,
        actor: actorResult.actor,
        irHash: currentHash,
        assertionConfigHash: currentConfigHash,
      });
    } catch (err) {
      req.log.error({ err, testId }, "approval audit append failed");
    }
    return withWeakAssertions(approved);
  });

  app.post("/api/tests/:testId/suggest-assertions", async (req, reply) => {
    const { testId } = req.params as { testId: string };
    if (!isSafeTestId(testId)) return reply.notFound("test not found");
    const test = await store.getTest(testId);
    if (!test) return reply.notFound("test not found");
    const { assertions, uncertainties, help, suggestions } = suggestAssertionsForTest(
      test.title,
      test.ir,
      test.intentSummary,
    );
    const constraintsDoc = await loadPilotConstraints();
    const filtered = filterForbiddenSuggestionTokens(suggestions, constraintsDoc?.forbiddenAssertions ?? []);
    return { assertions, uncertainties, help, suggestions: filtered, irHash: computeIRHash(test.ir) };
  });

  app.get("/api/assertions/providers", async () => ({
    providers: assertionProviderCatalog(),
  }));

  app.get("/api/assertions/config-catalog", async () => assertionConfigCatalog(repoRoot));

  app.post("/api/assertions/validate", async (req, reply) => {
    const body = req.body as { assertions?: StoredTest["ir"]["assertions"] };
    if (!body?.assertions?.length) {
      return reply.code(400).send({ error: "需要 assertions 数组" });
    }
    const issues = validateAssertionsDraft(body.assertions as Parameters<typeof validateAssertionsDraft>[0]);
    return { ok: issues.length === 0, issues };
  });

  app.post("/api/assertions/test-connection", async (req, reply) => {
    const body = req.body as { kind?: string; configRef?: string };
    if (body.kind !== "db" && body.kind !== "agent") {
      return reply.code(400).send({ error: "kind 必须为 db 或 agent" });
    }
    if (!body.configRef?.trim()) {
      return reply.code(400).send({ error: "需要 configRef" });
    }
    return testAssertionConnection(body.kind, body.configRef.trim(), repoRoot);
  });

  app.post("/api/assertions/preview", async (req, reply) => {
    const body = req.body as {
      assertion?: Parameters<typeof previewProviderAssertion>[0];
      runId?: string;
      traceRef?: string;
    };
    if (!body?.assertion) {
      return reply.code(400).send({ error: "需要 assertion" });
    }
    return previewProviderAssertion(body.assertion, repoRoot, {
      runId: body.runId,
      traceRef: body.traceRef,
    });
  });

  app.get("/api/pilot-constraints", async () => {
    const c = await loadPilotConstraints();
    return c ?? { scopeNotes: [], forbiddenAssertions: [] };
  });

  app.post("/api/intake", async (req, reply) => {
    const body = req.body as {
      title?: string;
      url?: string;
      channel?: "intent" | "prd";
      text?: string;
    };
    const title = body.title?.trim() || "未命名用例";
    const channel = body.channel === "prd" ? "prd" : "intent";
    const url = body.url?.trim() || (await pilotIntakeDefaultUrl());
    if (!url) {
      return reply.code(400).send({ error: "请在本机 .env 配置 TESTPILOT_PILOT_BASE_URL，或在请求中传入 url" });
    }
    try {
      new URL(url);
    } catch {
      return reply.code(400).send({ error: "URL 格式无效" });
    }
    if (!isAllowedTargetUrl(url)) {
      return reply.code(400).send({
        error:
          "目标 URL 不在允许列表。仅允许本机地址、TESTPILOT_PILOT_BASE_URL 与 TESTPILOT_ALLOWED_TARGETS 中的地址。",
      });
    }
    const constraintsDoc = await loadPilotConstraints();
    const constraintLine = constraintsDoc?.scopeNotes?.[0];
    const text = [body.text?.trim(), constraintLine].filter(Boolean).join("\n");
    if (!text) {
      return reply.code(400).send({ error: "请填写测试意图或粘贴 PRD 片段" });
    }

    let context;
    const pilotBase = pilotBaseUrl();
    const onPilot = pilotBase ? isPilotIntakeUrl(url, pilotBase) : false;
    try {
      await assertPlaywrightReady();
      if (onPilot) {
        if (!pilotSecretsConfigured()) {
          return reply.code(400).send({
            error:
              "试点 intake 需要先登录再快照：请配置 TESTPILOT_ENV_ADMIN_PHONE 与 TESTPILOT_ENV_ADMIN_PASSWORD",
          });
        }
        context = await capturePilotIntakeContext(pilotBase, url, {
          intentText: text,
          loginPath: (await loadPilotBaseline())?.loginPath,
        });
      } else {
        context = await snapshotAtUrl(url);
        if (looksLikeLoginPageContext(context)) {
          return reply.code(422).send({
            error: "页面看起来像登录页；试点地址请配置凭据，或先登录后再 intake",
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "无法打开页面生成草案";
      const code = message.includes("登录") ? 422 : 503;
      return reply.code(code).send({ error: message });
    }

    const ruleDraft = planFromIntake({
      title,
      channel,
      text,
      context,
      constraints: constraintsDoc?.scopeNotes,
    });
    const { draft, llmTokensUsed, llmUsed } = await applyOptionalLlmDraft({
      goal: text,
      context,
      ruleDraft,
    });
    const testId = makeIntakeTestId(title);
    const partial = draftToPartialIR(testId, draft);
    const ir = applyBaseUrlTarget(
      { ...partial, policy: { screenshots: "on-failure" as const } },
      url,
    );
    const validated = validateTestIR(ir);
    if (!validated.ok) {
      return reply.code(400).send({ issues: validated.issues });
    }

    const test = stampTestMeta({
      id: testId,
      projectId: "default",
      title,
      ir: validated.value,
      approvalStatus: "draft",
      intentSummary: body.text?.trim() || text,
      sourceChannel: channel,
      plannerNotes: draft.uncertainties,
      updatedAt: new Date().toISOString(),
    });
    await store.saveTest(test);
    return { test: withWeakAssertions(test), draft: { uncertainties: draft.uncertainties, sources: draft.sources }, llmUsed, llmTokensUsed };
  });

  async function executeRequirementFlow(
    body: {
      title?: string;
      text?: string;
      channel?: "intent" | "prd";
      target?: RequirementTarget;
      customUrl?: string;
      autoTrial?: boolean;
    },
    onStage: (stage: string) => void,
  ): Promise<{ code: number; payload: unknown }> {
    const out = { code: 200, payload: undefined as unknown };
    const reply = {
      code: (n: number) => ({
        send: (p: unknown) => {
          out.code = n;
          out.payload = p;
          return out;
        },
      }),
    };
    const channel = body.channel === "prd" ? "prd" : "intent";
    const text = body.text?.trim();
    if (!text) return reply.code(400).send({ error: "请粘贴需求描述或 PRD 片段" });
    const title = body.title?.trim() || titleFromRequirement(text);
    onStage("校验目标环境");
    const target: RequirementTarget =
      body.target === "pilot" || body.target === "custom" || body.target === "real"
        ? body.target
        : "demo";
    if (target === "real") {
      return reply.code(400).send({
        error: "真实环境目前只支持系统画像探测，暂不自动生成/试跑用例",
      });
    }
    const project = store.project();
    const pilotUrl = pilotBaseUrl();
    const pilotIntakeUrl = pilotUrl ? await pilotIntakeDefaultUrl() : "";
    const resolved = resolveRequirementTargetUrl({
      target,
      customUrl: body.customUrl,
      demoUrl: project.defaultBaseUrl,
      pilotUrl: pilotUrl ?? undefined,
      pilotIntakeUrl: pilotIntakeUrl || undefined,
    });
    if (!resolved.ok) return reply.code(400).send({ error: resolved.error });
    const url = resolved.url;
    if (!isAllowedTargetUrl(url)) {
      return reply.code(400).send({ error: "目标 URL 不在允许列表" });
    }
    if (!(await checkTargetReachable(url))) {
      return reply.code(503).send({ error: `目标环境不可达: ${url}` });
    }

    const constraintsDoc = await loadPilotConstraints();

    let context;
    const onPilot = pilotUrl ? isPilotIntakeUrl(url, pilotUrl) : false;
    onStage(onPilot ? "登录试点并采集页面" : "打开目标页面并采集");
    try {
      await assertPlaywrightReady();
      if (onPilot) {
        if (!pilotSecretsConfigured()) {
          return reply.code(400).send({
            error: "试点需先配置 TESTPILOT_ENV_ADMIN_PHONE / TESTPILOT_ENV_ADMIN_PASSWORD",
          });
        }
        context = await capturePilotIntakeContext(pilotUrl, url, {
          intentText: text,
          loginPath: (await loadPilotBaseline())?.loginPath,
        });
      } else {
        context = await snapshotAtUrl(url);
        if (looksLikeLoginPageContext(context)) {
          return reply.code(422).send({ error: "页面像登录页；试点请选择试点环境并配置凭据" });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "无法打开页面";
      return reply.code(503).send({ error: message });
    }

    // Constraints are hints, not part of the requirement text: appending them
    // used to make unrelated requirements match the ticket template.
    onStage("生成测试步骤与断言");
    const ruleDraft = planFromIntake({
      title,
      channel,
      text,
      context,
      constraints: constraintsDoc?.scopeNotes,
    });
    const { draft, llmTokensUsed, llmUsed } = await applyOptionalLlmDraft({
      goal: text,
      context,
      ruleDraft,
    });
    const testId = makeIntakeTestId(title);
    const steps = mergeRequirementSteps(onPilot, onPilot ? await pilotLoginSteps() : [], draft.steps);
    // The pilot's success toast is transient and can vanish before assertions run;
    // the create request (200 + our unique run marker in the body) is durable evidence.
    const assertedOnSubmit = onPilot && draft.steps.some((s) => s.id === "submit-form");
    const assertions = resolveRequirementAssertions(assertedOnSubmit, draft.assertions);
    const partial = draftToPartialIR(testId, { ...draft, steps, assertions });
    if (assertedOnSubmit) {
      draft.uncertainties.push(
        "成功断言使用试点创建接口：HTTP 200 且请求体包含本次运行的 TestPilot- 标记；Toast 会消失，不作为唯一证据。",
      );
    }
    const ir = onPilot
      ? {
          ...partial,
          baseUrlRef: "pilot-admin",
          policy: {
            screenshots: "on-failure" as const,
            retry: { attempts: 1, on: ["ENVIRONMENT" as const] },
          },
        }
      : applyBaseUrlTarget({ ...partial, policy: { screenshots: "on-failure" as const } }, url);
    const validated = validateTestIR(ir);
    if (!validated.ok) return reply.code(400).send({ issues: validated.issues });
    const missing = [...new Set(missingEnvRefs(validated.value))];
    if (missing.length) {
      return reply.code(400).send({
        error: `用例引用了未配置的环境变量：${missing.join(", ")}（见 .env.example）`,
      });
    }

    const stored = stampTestMeta({
      id: testId,
      projectId: project.id,
      title,
      ir: validated.value,
      approvalStatus: "draft",
      intentSummary: text,
      sourceChannel: channel,
      plannerNotes: draft.uncertainties,
      updatedAt: new Date().toISOString(),
    });
    onStage("保存草稿");
    await store.saveTest(stored);
    let storedTest = stored;
    const observedNotes: string[] = [];

    const autoTrial = body.autoTrial !== false;
    let trialRun: StoredRun | undefined;
    let trialError: string | undefined;
    if (autoTrial) {
      onStage("自动试跑中");
      try {
        trialRun = await executeSingleIrRun(
          store,
          stored,
          validated.value,
          url,
          project.id,
          artifactsRoot,
          dataRoot,
        );
      } catch (err) {
        trialError = err instanceof Error ? err.message : String(err);
      }
    }

    // Steps worked but the guessed assertion missed: use the success text the page
    // actually showed, then re-trial once. A human still approves it.
    if (trialRun && trialRun.status !== "passed") {
      const signal = pickObservedSuccessSignal(trialRun);
      if (signal) {
        onStage("按页面真实成功文案重试");
        const passedIds = new Set(
          trialRun.assertions.filter((a) => a.passed).map((a) => a.assertionId),
        );
        const kept = validated.value.assertions.filter((a) => a.id && passedIds.has(a.id));
        const next = validateTestIR({
          ...validated.value,
          assertions: [
            ...kept,
            {
              id: "observed-success",
              type: "ui",
              contains: signal,
              oracle: "human-approved",
            },
          ],
        });
        if (next.ok) {
          observedNotes.push(`试跑观察到成功提示「${signal}」，已用它作为断言并复跑确认。`);
          storedTest = stampTestMeta({
            ...stored,
            ir: next.value,
            plannerNotes: [...(stored.plannerNotes ?? []), observedNotes[observedNotes.length - 1]!],
          });
          await store.saveTest(storedTest);
          try {
            trialRun = await executeSingleIrRun(
              store,
              storedTest,
              next.value,
              url,
              project.id,
              artifactsRoot,
              dataRoot,
            );
          } catch (err) {
            trialError = err instanceof Error ? err.message : String(err);
          }
        }
      }
    }

    onStage("完成");
    out.payload = {
      environment: { target, label: resolved.label, url },
      test: withWeakAssertions(storedTest),
      generation: {
        uncertainties: [...draft.uncertainties, ...observedNotes],
        sources: draft.sources,
        llmUsed,
        llmTokensUsed,
        stepCount: draft.steps.length,
      },
      trial: trialRun ? { run: trialRun, trial: true } : undefined,
      trialError,
      autoTrial,
    };
    return out;
  }

  type RequirementJob = {
    id: string;
    status: "running" | "completed" | "failed";
    stage: string;
    startedAt: string;
    completedAt?: string;
    result?: unknown;
    error?: string;
  };
  const requirementJobs = new Map<string, RequirementJob>();
  const detectionJobs = new Map<string, DetectionJob>();

  app.post("/api/requirement-flow", async (req, reply) => {
    const out = await executeRequirementFlow(
      (req.body ?? {}) as Parameters<typeof executeRequirementFlow>[0],
      () => undefined,
    );
    return reply.code(out.code).send(out.payload);
  });

  app.post("/api/requirement-flow/jobs", async (req, reply) => {
    const body = (req.body ?? {}) as Parameters<typeof executeRequirementFlow>[0];
    const id = `req_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
    const job: RequirementJob = {
      id,
      status: "running",
      stage: "排队中",
      startedAt: new Date().toISOString(),
    };
    requirementJobs.set(id, job);
    if (requirementJobs.size > 50) {
      const oldest = requirementJobs.keys().next().value;
      if (oldest) requirementJobs.delete(oldest);
    }
    void executeRequirementFlow(body, (stage) => {
      job.stage = stage;
    })
      .then((out) => {
        job.completedAt = new Date().toISOString();
        if (out.code >= 400) {
          job.status = "failed";
          const payload = out.payload as { error?: string; issues?: unknown };
          job.error = payload?.error ?? `HTTP ${out.code}`;
        } else {
          job.status = "completed";
          job.stage = "完成";
          job.result = out.payload;
        }
      })
      .catch((err) => {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        job.completedAt = new Date().toISOString();
      });
    return reply.code(202).send({ jobId: id });
  });

  app.get("/api/requirement-flow/jobs/:jobId", async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const job = requirementJobs.get(jobId);
    if (!job) return reply.notFound("job not found");
    return job;
  });

  app.post("/api/detect/jobs", async (req, reply) => {
    const body = (req.body ?? {}) as { target?: DetectionTarget; customUrl?: string };
    const target: DetectionTarget =
      body.target === "pilot" || body.target === "custom" || body.target === "real"
        ? body.target
        : "demo";
    if (target === "custom" && !body.customUrl?.trim()) {
      return reply.code(400).send({ error: "自定义环境需要填写 URL" });
    }
    const pilotUrl = pilotBaseUrl();
    const project = store.project();
    const pilotIntakeUrl = pilotUrl ? await pilotIntakeDefaultUrl() : "";
    const loginPath = (await loadPilotBaseline())?.loginPath;
    const id = `detectjob_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
    const job: DetectionJob = {
      id,
      status: "running",
      stage: "排队中",
      startedAt: new Date().toISOString(),
    };
    detectionJobs.set(id, job);
    if (detectionJobs.size > 50) {
      const oldest = detectionJobs.keys().next().value;
      if (oldest) detectionJobs.delete(oldest);
    }
    void runDetection(
      {
        dataRoot,
        target,
        customUrl: target === "custom" ? body.customUrl?.trim() : undefined,
        demoUrl: project.defaultBaseUrl,
        pilotUrl: pilotUrl || undefined,
        pilotIntakeUrl: pilotIntakeUrl || undefined,
        realUrl: realBaseUrl() || undefined,
        loginPath,
      },
      (stage) => {
        job.stage = stage;
      },
    )
      .then((record) => {
        job.status = "completed";
        job.stage = "完成";
        job.completedAt = new Date().toISOString();
        job.result = record;
        void autoPruneArtifacts({ artifactsRoot, dataRoot }).catch(() => undefined);
      })
      .catch((err) => {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        job.completedAt = new Date().toISOString();
      });
    return reply.code(202).send({ jobId: id });
  });

  app.get("/api/detect/jobs/:jobId", async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    if (!isSafeRunId(jobId)) return reply.notFound("job not found");
    const job = detectionJobs.get(jobId);
    if (!job) return reply.notFound("job not found");
    return job;
  });

  app.get("/api/detect/latest", async (req) => {
    const query = req.query as { target?: string; url?: string };
    const target: DetectionTarget =
      query.target === "pilot" || query.target === "custom" || query.target === "real"
        ? query.target
        : "demo";
    const record = await latestDetection(dataRoot, target, query.url);
    return { record: record ?? null };
  });

  app.get("/api/detect", async () => ({
    detections: await listDetections(dataRoot, 20),
  }));

  app.get("/api/detect/:detectionId", async (req, reply) => {
    const { detectionId } = req.params as { detectionId: string };
    const record = await readDetection(dataRoot, detectionId);
    if (!record) return reply.notFound("detection not found");
    return record;
  });

  app.get("/api/environment", async () => {
    const project = store.project();
    const pilotUrl = pilotBaseUrl();
    const pilotIntakeUrl = pilotUrl ? await pilotIntakeDefaultUrl() : "";
    const demoReachable = await checkTargetReachable(DEMO_BASE_URL);
    const pilotReachable = pilotUrl ? await checkTargetReachable(pilotUrl) : false;
    const realUrl = realBaseUrl();
    const realReachable = realUrl ? await checkTargetReachable(realUrl) : false;
    return {
      demoUrl: project.defaultBaseUrl,
      demoReachable,
      pilotUrl,
      pilotIntakeUrl: pilotIntakeUrl || null,
      pilotReachable,
      pilotSecretsConfigured: pilotSecretsConfigured(),
      realUrl,
      realReachable,
      realSecretsConfigured: realSecretsConfigured(),
      llm: llmPlannerPublicInfo(),
      llmUsage: llmUsageSnapshot(),
      approval: approvalIdentityPublicInfo(),
      apiVersion: "0.2.0",
    };
  });

  app.get("/api/audit", async (req) => {
    const query = req.query as { limit?: string };
    const limit = query.limit ? Number.parseInt(query.limit, 10) : 50;
    const entries = await readAuditLog(dataRoot, Number.isFinite(limit) ? limit : 50);
    return { entries };
  });

  app.get("/api/metrics/flake", async () => {
    const batches = (await store.listBatches(10)).filter((b) => b.status === "completed");
    const runsById = new Map((await store.listRuns(1000)).map((r) => [r.runId, r]));
    const scoped: StoredRun[] = [];
    for (const batch of batches) {
      for (const runId of batch.runIds) {
        const run = runsById.get(runId);
        if (run && !run.trial) scoped.push(run);
      }
    }
    const report = buildFlakeMetricsReport(scoped);
    return { report, batchCount: batches.length, targets: { passRateMin: 0.95, flakeRateMax: 0.05 } };
  });

  app.get("/api/metrics/baseline", async () => {
    const batches = await store.listBatches(50);
    const runs = await store.listRuns(500);
    const report = computeRegressionBaseline(batches, new Map(runs.map((r) => [r.runId, r])));
    return { report, targets: { passRateMin: 0.95, flakeRateMax: 0.05 } };
  });

  app.get("/api/metrics/summary", async () => {
    const allRuns = await store.listRuns(100);
    const runs = allRuns.filter((r) => !r.trial);
    const passed = runs.filter((r) => r.status === "passed").length;
    const totalMs = runs.reduce((s, r) => s + (r.metrics?.durationMs ?? 0), 0);
    const tests = await store.listTests();
    const approvedList = tests.filter((t) => t.approvalStatus === "approved");
    const approved = approvedList.length;
    const approvedPilotCount = approvedList.filter((t) => isPilotTest(t)).length;
    const approvedDemoCount = approved - approvedPilotCount;
    const weakApproved = approvedList
      .map((t) => ({ id: t.id, title: t.title, count: weakAssertionIssues(t.ir).length }))
      .filter((t) => t.count > 0);
    const baseline = await loadPilotBaseline();
    const baselineMin = baseline?.manualRegressionMinutes ?? null;
    const llmUsage = llmUsageSnapshot();
    const flake = computeFlakeStats(runs);
    const storedBatches = (await store.listBatches(10)).filter((b) => b.status !== "running");
    const batchRunIds = new Set(storedBatches.flatMap((b) => b.runIds));
    const batchRunCount = runs.filter((r) => batchRunIds.has(r.runId)).length;
    const standaloneRunCount = runs.length - batchRunCount;
    const recentBatches = storedBatches.slice(0, 8).map(metricsFromBatchRecord);
    const fullBatch = storedBatches.find((b) => b.mode === "full" && (b.repeatCount ?? 1) === 1);
    const lastBatchMs = fullBatch ? metricsFromBatchRecord(fullBatch).durationMs : null;
    const batchMinutes = lastBatchMs != null ? lastBatchMs / 60_000 : null;
    const minutesSavedVsBaseline =
      batchMinutes != null && baselineMin != null ? Math.max(0, Math.round((baselineMin - batchMinutes) * 10) / 10) : null;
    return {
      runCount: runs.length,
      batchRunCount,
      standaloneRunCount,
      passRate: runs.length ? passed / runs.length : 0,
      avgDurationMs: runs.length ? Math.round(totalMs / runs.length) : 0,
      llmTokensTotal: llmUsage.tokensTotal,
      llmCallCount: llmUsage.callCount,
      approvedTestCount: approved,
      approvedPilotCount,
      approvedDemoCount,
      weakApprovedCount: weakApproved.length,
      weakApprovedTests: weakApproved,
      lastBatchDurationMs: lastBatchMs,
      lastBatchMinutes: lastBatchMs != null ? Math.round((lastBatchMs / 60_000) * 10) / 10 : null,
      pilotBaselineMinutes: baselineMin,
      pilotBaselineNotes: baseline?.notes ?? null,
      minutesSavedVsBaseline,
      recentBatches,
      flakeRecoveryCount: flake.flakeRecoveryCount,
      flakeRecoveryRate: flake.flakeRecoveryRate,
      multiAttemptRuns: flake.multiAttemptRuns,
      negativeProbes: await readNegativeProbeReport(artifactsRoot),
    };
  });

  app.get("/api/metrics/negative-probes", async () => {
    const report = await readNegativeProbeReport(artifactsRoot);
    if (!report) {
      return {
        ok: false,
        error: "尚未生成负向探针报告；本地请运行 pnpm negative-probes",
        probes: [],
      };
    }
    return report;
  });

  app.get("/api/batch-runs/:jobId", async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    if (!isSafeRunId(jobId)) return reply.notFound("batch job not found");
    const job = batchJobs.get(jobId);
    if (!job) return reply.notFound("batch job not found");
    return { ...job, runs: job.runs.map(redactRunForApi) };
  });

  app.get("/api/batches", async () => ({ batches: await store.listBatches(24) }));

  app.get("/api/batches/:batchId", async (req, reply) => {
    const { batchId } = req.params as { batchId: string };
    if (!isSafeRunId(batchId)) return reply.notFound("batch not found");
    const batch = await store.getBatch(batchId);
    if (!batch) return reply.notFound("batch not found");
    const job = batchJobs.get(batchId);
    const storedRuns: StoredRun[] = [];
    for (const runId of batch.runIds) {
      const run = await store.getRun(runId);
      if (run) storedRuns.push(run);
    }
    const runs = job && storedRuns.length < job.runs.length ? job.runs : storedRuns;
    return { batch, runs: runs.map(redactRunForApi) };
  });

  app.post("/api/projects/:projectId/runs", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = (req.body ?? {}) as {
      testId?: string;
      baseUrl?: string;
      includeDraft?: boolean;
      repeatCount?: number;
    };
    const repeatCount = normalizeRepeatCount(body.repeatCount);
    const project = store.project();
    const baseUrl = body.baseUrl ?? project.defaultBaseUrl;
    if (body.testId && !isSafeTestId(body.testId)) {
      return reply.code(400).send({ error: "invalid testId" });
    }
    if (!isAllowedTargetUrl(baseUrl)) {
      return reply.code(400).send({
        error:
          "目标 baseUrl 不在允许列表。仅允许本机地址、TESTPILOT_PILOT_BASE_URL 与 TESTPILOT_ALLOWED_TARGETS 中的地址。",
      });
    }

    let tests = body.testId
      ? [await store.getTest(body.testId)].filter(Boolean)
      : await store.listTests();
    if (!body.testId && !body.includeDraft) {
      tests = (tests as StoredTest[]).filter((t) => t.approvalStatus === "approved");
    }
    const baseList = tests as StoredTest[];
    if (baseList.length === 0) {
      return reply.code(400).send({ error: "没有可运行的用例（需已批准）" });
    }
    const list =
      repeatCount > 1 ? baseList.flatMap((t) => Array.from({ length: repeatCount }, () => t)) : baseList;

    const runEnv = buildRunEnvironment(baseUrl);
    let targets: string[];
    try {
      targets = uniqueTargetBaseUrls(list, runEnv);
    } catch (err) {
      return reply.code(503).send({ error: err instanceof Error ? err.message : String(err) });
    }
    for (const url of targets) {
      if (!isAllowedTargetUrl(url)) {
        return reply.code(400).send({ error: `用例目标地址不在允许列表: ${url}` });
      }
    }
    for (const url of absoluteStepUrls(list)) {
      if (!isAllowedTargetUrl(url)) {
        return reply.code(400).send({ error: `步骤目标地址不在允许列表: ${url}` });
      }
    }
    const missingSecrets = [...new Set(list.flatMap((t) => missingEnvRefs(t.ir)))];
    if (missingSecrets.length) {
      return reply.code(503).send({
        error: `缺少用例所需环境变量：${missingSecrets.join(", ")}（见 .env.example）`,
      });
    }
    for (const url of targets) {
      if (!(await checkTargetReachable(url))) {
        return reply.code(503).send({ error: `目标环境不可达: ${url}` });
      }
    }

    if (list.length === 1) {
      const results = await executeRuns(store, list, baseUrl, project.id, artifactsRoot, dataRoot);
      void autoPruneArtifacts({ artifactsRoot, dataRoot }).catch(() => undefined);
      return { runs: results, async: false, repeatCount };
    }

    const jobId = `batch_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const job: RunBatchJob = {
      id: jobId,
      batchId: jobId,
      status: "running",
      total: list.length,
      completed: 0,
      runs: [],
      startedAt: new Date().toISOString(),
    };
    batchJobs.set(jobId, job);

    const batchRecord: StoredBatch = {
      batchId: jobId,
      startedAt: job.startedAt,
      total: list.length,
      passed: 0,
      status: "running",
      runIds: [],
      mode: body.testId ? "selected" : body.includeDraft ? "include-draft" : "full",
      repeatCount,
    };
    await store.saveBatch(batchRecord);

    void executeRuns(store, list, baseUrl, projectId, artifactsRoot, dataRoot, job)
      .then(async (runs) => {
        job.status = "completed";
        job.runs = runs;
        job.completedAt = new Date().toISOString();
        const runIds = runs.map((r) => r.runId);
        const artifactBytesTotal = await measureBatchArtifactBytes(artifactsRoot, runIds);
        await store.saveBatch({
          ...batchRecord,
          completedAt: job.completedAt,
          passed: runs.filter((r) => r.status === "passed").length,
          status: "completed",
          runIds,
          artifactBytesTotal,
        });
        await refreshRegressionBaselineReport(store, dataRoot);
        void autoPruneArtifacts({ artifactsRoot, dataRoot }).catch(() => undefined);
      })
      .catch(async (err) => {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        job.completedAt = new Date().toISOString();
        const runIds = job.runs.map((r) => r.runId);
        const artifactBytesTotal = await measureBatchArtifactBytes(artifactsRoot, runIds);
        await store.saveBatch({
          ...batchRecord,
          completedAt: job.completedAt,
          passed: job.runs.filter((r) => r.status === "passed").length,
          status: "failed",
          runIds,
          error: job.error,
          artifactBytesTotal,
        });
        await refreshRegressionBaselineReport(store, dataRoot);
      });

    return {
      jobId,
      batchId: jobId,
      async: true,
      total: list.length,
      repeatCount,
      batch: batchRecord,
      maxParallel: maxParallelFromEnv(),
    };
  });

  app.get("/api/runs", async () => (await store.listRuns(100)).map(redactRunForApi));

  app.get("/api/runs/:runId", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    if (!isSafeRunId(runId)) return reply.notFound("run not found");
    const run = await store.getRun(runId);
    if (!run) return reply.notFound("run not found");
    return { ...redactRunForApi(run), artifactsPresent: artifactPresence(run, artifactsRoot) };
  });

  app.get("/api/runs/:runId/diagnose", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    if (!isSafeRunId(runId)) return reply.notFound("run not found");
    const run = await store.getRun(runId);
    if (!run) return reply.notFound("run not found");
    if (run.status === "passed") {
      return { runId, status: run.status, failureKind: null, suggestions: [] as string[] };
    }
    const rawStepMsg = run.steps.find((s) => s.message)?.message;
    const rawAssertionMsg = run.assertions.find((a) => !a.passed)?.message;
    const stepMsg = rawStepMsg ? redactStringBody(rawStepMsg) : undefined;
    const assertionMsg = rawAssertionMsg ? redactStringBody(rawAssertionMsg) : undefined;
    const failureKind =
      run.metrics?.failureKind ??
      classifyFailure({ stepError: rawStepMsg, assertionMessage: rawAssertionMsg });
    const suggestions: string[] = [];
    if (failureKind === "LOCATOR_BREAKAGE") {
      suggestions.push("检查练习应用是否改版；优先为按钮添加 data-testid 并重新录制。");
      suggestions.push("可在 IR 步骤 target 上同时保留 testId 与 role+name 作为回退。");
    } else if (failureKind === "ENVIRONMENT") {
      suggestions.push("确认练习应用 4173 与 baseUrl 可达；查看 network.json 与 trace。");
      if (pilotBaseUrl() && run.testTitle.includes("试点")) {
        suggestions.push("试点：检查 TESTPILOT_PILOT_BASE_URL、本机网络与 .env 中的管理员凭据。");
      }
    } else if (failureKind === "PRODUCT_DEFECT") {
      suggestions.push("断言与产品行为不一致：确认是否为真实缺陷或断言过时。");
    } else {
      suggestions.push("下载 Trace 与 network.json；必要时重新录制步骤。");
    }
    let llmUsed = false;
    let llmTokensUsed = 0;
    const llmConfig = llmPlannerConfigFromEnv();
    if (llmConfig) {
      try {
        const enhanced = await suggestDiagnoseWithLlm(llmConfig, {
          testTitle: run.testTitle,
          failureKind,
          stepError: stepMsg,
          assertionMessage: assertionMsg,
          ruleSuggestions: suggestions,
        });
        suggestions.length = 0;
        suggestions.push(...enhanced.suggestions);
        llmUsed = true;
        llmTokensUsed = enhanced.tokensUsed;
      } catch {
        /* keep rule-only suggestions */
      }
    }
    return {
      runId,
      status: run.status,
      failureKind,
      stepError: stepMsg,
      assertionMessage: assertionMsg,
      suggestions,
      llmUsed,
      llmTokensUsed,
      plannerLlmAvailable: !!llmPlannerConfigFromEnv(),
    };
  });

  app.post("/api/plan", async (req, reply) => {
    const body = req.body as { goal: string; url?: string };
    if (!body.goal?.trim()) return reply.code(400).send({ error: "goal is required" });
    const project = store.project();
    const url = body.url ?? project.defaultBaseUrl;
    if (!isAllowedTargetUrl(url)) {
      return reply.code(400).send({
        error:
          "目标 URL 不在允许列表。仅允许本机地址、TESTPILOT_PILOT_BASE_URL 与 TESTPILOT_ALLOWED_TARGETS 中的地址。",
      });
    }
    const reachable = await checkTargetReachable(url);
    if (!reachable) {
      return reply.code(503).send({ error: "目标页面不可达，请先启动练习应用" });
    }
    let context;
    try {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      context = await snapshotPageContext(page);
      await browser.close();
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
    const ruleDraft = planDraft({ goal: body.goal.trim(), context });
    const { draft, llmTokensUsed, llmUsed } = await applyOptionalLlmDraft({
      goal: body.goal.trim(),
      context,
      ruleDraft,
    });
    return { draft, contextElementCount: context.elements.length, llmTokensUsed, llmUsed };
  });

  app.get("/api/runs/:runId/artifacts/*", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const wildcard = (req.params as { "*": string })["*"] ?? "";
    if (!isSafeRunId(runId)) return reply.notFound("run not found");
    const run = await store.getRun(runId);
    if (!run) return reply.notFound("run not found");
    if (!isSafeArtifactName(wildcard)) return reply.notFound("artifact not found");

    const root = resolve(artifactsRoot);
    const rawRunDir = run.artifacts?.dir ?? join(root, "runs", runId);
    const runDir = resolve(isAbsolute(rawRunDir) ? rawRunDir : resolve(root, "..", rawRunDir));
    if (runDir === root || !isWithin(root, runDir)) return reply.notFound("artifact not found");

    const registered = run.artifacts?.artifacts?.find((a) => basename(a.path) === wildcard);
    let filePath: string | null = registered
      ? resolve(isAbsolute(registered.path) ? registered.path : join(runDir, registered.path))
      : null;
    if (filePath && !isWithin(runDir, filePath)) filePath = null;
    if (!filePath && wildcard === "network.json") filePath = resolveWithin(runDir, wildcard);
    if (!filePath || filePath === runDir) return reply.notFound("artifact not found");

    if (!existsSync(filePath)) {
      if (wildcard === "network.json") {
        await mkdir(runDir, { recursive: true });
        await writeFile(filePath, "[]\n", "utf8");
      } else {
        return reply.notFound("artifact not found");
      }
    }
    if (filePath.endsWith(".zip")) reply.type("application/zip");
    if (filePath.endsWith(".png")) reply.type("image/png");
    if (filePath.endsWith(".json")) reply.type("application/json");
    return reply.send(createReadStream(filePath));
  });

  app.post("/api/record", async (req, reply) => {
    if (recordLock) {
      return reply.code(409).send({ error: "已有录制进行中，请先关闭录制浏览器窗口后再试" });
    }
    const body = req.body as { url?: string; testId?: string; title?: string; intentSummary?: string };
    if (!body?.url?.trim()) {
      return reply.code(400).send({ error: "请提供录制起始 URL" });
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(body.url.trim());
    } catch {
      return reply.code(400).send({ error: "URL 格式无效" });
    }
    if (!isAllowedTargetUrl(parsedUrl.toString())) {
      return reply.code(400).send({
        error:
          "录制 URL 不在允许列表。仅允许本机地址、TESTPILOT_PILOT_BASE_URL 与 TESTPILOT_ALLOWED_TARGETS 中的地址。",
      });
    }
    const testId = (body.testId?.trim() || `rec-${Date.now()}`).toLowerCase();
    if (!isSafeTestId(testId)) {
      return reply.code(400).send({ error: "testId 只能包含小写字母、数字和连字符（最长 128）" });
    }

    const jobId = `rec_${Date.now()}`;
    const job: RecordJob = { id: jobId, status: "running", startedAt: new Date().toISOString() };
    recordJobs.set(jobId, job);
    recordLock = true;

    void (async () => {
      try {
        await assertPlaywrightReady();
        const { ir: recordedIr, warnings } = await recordSession({ url: parsedUrl.toString(), testId });
        const ir = applyBaseUrlTarget(recordedIr, parsedUrl.toString());
        const validated = validateTestIR(ir);
        if (!validated.ok) {
          throw new Error(`录制 IR 校验失败: ${validated.issues.map((i) => i.message).join("; ")}`);
        }
        const test = stampTestMeta({
          id: testId,
          projectId: "default",
          title: body.title?.trim() || testId,
          ir: validated.value,
          approvalStatus: "draft",
          intentSummary:
            body.intentSummary?.trim() ||
            (body.title?.includes("工单")
              ? "提交工单流程；不要上传附件，附件功能暂不测试。"
              : undefined),
          sourceChannel: "record",
          plannerNotes: warnings.length ? warnings : undefined,
          updatedAt: new Date().toISOString(),
        });
        await store.saveTest(test);
        job.status = "completed";
        job.testId = testId;
        job.completedAt = new Date().toISOString();
        job.error = warnings.length ? warnings.join("; ") : undefined;
      } catch (err) {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        job.completedAt = new Date().toISOString();
      } finally {
        recordLock = false;
      }
    })();

    return { jobId, status: "running" };
  });

  app.get("/api/record/:jobId", async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    if (!isSafeRunId(jobId)) return reply.notFound("job not found");
    const job = recordJobs.get(jobId);
    if (!job) return reply.notFound("job not found");
    return job;
  });
}

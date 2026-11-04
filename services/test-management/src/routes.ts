import type { FastifyInstance } from "fastify";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { assertPlaywrightReady, recordSession } from "@testpilot/recorder-web";
import { runTestIR, type RunResult } from "@testpilot/runner-web";
import { snapshotPageContext } from "@testpilot/context-web";
import { draftToPartialIR, planDraft, planFromIntake, suggestAssertionsForTest, filterForbiddenSuggestionTokens } from "@testpilot/planner";
import { computeIRHash, IR_HASH_VERSION, validateSemantics, validateTestIR, weakAssertionIssues } from "@testpilot/test-ir";
import { classifyFailure } from "@testpilot/evidence";
import { chromium } from "playwright";
import type { FileStore, RecordJob, StoredRun, StoredTest } from "./store.js";
import { llmUsageSnapshot } from "./llm-usage.js";
import {
  applyOptionalLlmDraft,
  llmPlannerConfigFromEnv,
  llmPlannerPublicInfo,
  suggestDiagnoseWithLlm,
} from "./llm-planner.js";
import {
  applyBaseUrlTarget,
  buildRunEnvironment,
  isPilotTest,
  missingEnvRefs,
  pilotBaseUrl,
  pilotSecretsConfigured,
  uniqueTargetBaseUrls,
  DEMO_BASE_URL,
} from "./run-env.js";
import { estimateLastBatchDurationMs, groupRunsIntoBatches } from "./batch-metrics.js";
import {
  isAllowedTargetUrl,
  isSafeArtifactName,
  isSafeRunId,
  isSafeTestId,
  isWithin,
  resolveWithin,
} from "./security.js";

const recordJobs = new Map<string, RecordJob>();
let recordLock = false;

export type RunBatchJob = {
  id: string;
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

function stampTestMeta(test: StoredTest, opts?: { approving?: boolean }): StoredTest {
  const irHash = computeIRHash(test.ir);
  const next: StoredTest = { ...test, irHash, irHashVersion: IR_HASH_VERSION, updatedAt: new Date().toISOString() };
  if (opts?.approving) {
    next.approvalStatus = "approved";
    next.approvedAt = new Date().toISOString();
  }
  return next;
}

function withWeakAssertions(test: StoredTest) {
  return { ...test, weakAssertions: weakAssertionIssues(test.ir) };
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
  const suffix = Date.now().toString(36);
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
} | null> {
  const doc = await readLocalJson<{
    manualRegressionMinutes?: number;
    notes?: string;
    baseUrl?: string;
    loginPath?: string;
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
  const path = baseline?.loginPath?.trim() || "/customer";
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

async function executeRuns(
  store: FileStore,
  tests: StoredTest[],
  baseUrl: string,
  projectId: string,
  artifactsRoot: string,
  dataRoot: string,
  job?: RunBatchJob,
): Promise<StoredRun[]> {
  const results: StoredRun[] = [];
  for (const test of tests) {
    if (job) {
      job.currentTitle = test.title;
    }
    const v = validateTestIR(test.ir);
    if (!v.ok) {
      if (job) job.completed += 1;
      continue;
    }
    const runEnv = buildRunEnvironment(baseUrl);
    const result = await runTestIR(v.value, {
      headless: true,
      artifactsDir: join(artifactsRoot, "runs"),
      env: runEnv,
    });
    const artifacts = await ensureNetworkArtifact(result.artifacts);
    const stored: StoredRun = {
      ...result,
      artifacts,
      projectId,
      testTitle: test.title,
    };
    await store.saveRun(stored);
    results.push(stored);
    if (job) {
      job.completed += 1;
      job.runs = [...results];
    }
    await appendFile(
      join(dataRoot, "metrics.jsonl"),
      `${JSON.stringify({
        at: stored.completedAt,
        testId: stored.testId,
        status: stored.status,
        durationMs: stored.metrics?.durationMs,
        failureKind: stored.metrics?.failureKind,
        llmTokens: 0,
      })}\n`,
    );
  }
  return results;
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
    await store.saveTest(updated);
    return withWeakAssertions(updated);
  });

  app.delete("/api/tests/:testId", async (req, reply) => {
    const { testId } = req.params as { testId: string };
    if (!isSafeTestId(testId)) return reply.notFound("test not found");
    await store.deleteTest(testId);
    return { ok: true };
  });

  app.post("/api/tests/:testId/approve", async (req, reply) => {
    const { testId } = req.params as { testId: string };
    if (!isSafeTestId(testId)) return reply.notFound("test not found");
    const test = await store.getTest(testId);
    if (!test) return reply.notFound("test not found");
    const body = (req.body ?? {}) as { irHash?: string };
    const currentHash = computeIRHash(test.ir);
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
    const actorHeader = req.headers["x-testpilot-actor"];
    const actor = String(Array.isArray(actorHeader) ? actorHeader[0] : actorHeader ?? "local").slice(0, 80);
    const approved = { ...stampTestMeta(test, { approving: true }), approvedBy: actor };
    await store.saveTest(approved);
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
    try {
      await assertPlaywrightReady();
      context = await snapshotAtUrl(url);
    } catch (err) {
      return reply.code(503).send({
        error: err instanceof Error ? err.message : "无法打开页面生成草案",
      });
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

  app.get("/api/environment", async () => {
    const project = store.project();
    const pilotUrl = pilotBaseUrl();
    const pilotIntakeUrl = pilotUrl ? await pilotIntakeDefaultUrl() : "";
    const demoReachable = await checkTargetReachable(DEMO_BASE_URL);
    const pilotReachable = pilotUrl ? await checkTargetReachable(pilotUrl) : false;
    return {
      demoUrl: project.defaultBaseUrl,
      demoReachable,
      pilotUrl,
      pilotIntakeUrl: pilotIntakeUrl || null,
      pilotReachable,
      pilotSecretsConfigured: pilotSecretsConfigured(),
      llm: llmPlannerPublicInfo(),
      llmUsage: llmUsageSnapshot(),
      apiVersion: "0.2.0",
    };
  });

  app.get("/api/metrics/summary", async () => {
    const runs = await store.listRuns(100);
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
    const lastBatchMs = estimateLastBatchDurationMs(runs);
    const batchMinutes = lastBatchMs != null ? lastBatchMs / 60_000 : null;
    const baselineMin = baseline?.manualRegressionMinutes ?? null;
    const minutesSavedVsBaseline =
      batchMinutes != null && baselineMin != null ? Math.max(0, Math.round((baselineMin - batchMinutes) * 10) / 10) : null;
    const llmUsage = llmUsageSnapshot();
    return {
      runCount: runs.length,
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
      lastBatchMinutes: batchMinutes != null ? Math.round(batchMinutes * 10) / 10 : null,
      pilotBaselineMinutes: baselineMin,
      pilotBaselineNotes: baseline?.notes ?? null,
      minutesSavedVsBaseline,
      recentBatches: groupRunsIntoBatches(runs).slice(0, 8),
    };
  });

  app.get("/api/batch-runs/:jobId", async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    if (!isSafeRunId(jobId)) return reply.notFound("batch job not found");
    const job = batchJobs.get(jobId);
    if (!job) return reply.notFound("batch job not found");
    return job;
  });

  app.post("/api/projects/:projectId/runs", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = (req.body ?? {}) as { testId?: string; baseUrl?: string; includeDraft?: boolean };
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
    const list = tests as StoredTest[];
    if (list.length === 0) {
      return reply.code(400).send({ error: "没有可运行的用例（需已批准）" });
    }

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
      return { runs: results, async: false };
    }

    const jobId = `batch_${Date.now()}`;
    const job: RunBatchJob = {
      id: jobId,
      status: "running",
      total: list.length,
      completed: 0,
      runs: [],
      startedAt: new Date().toISOString(),
    };
    batchJobs.set(jobId, job);

    void executeRuns(store, list, baseUrl, projectId, artifactsRoot, dataRoot, job)
      .then((runs) => {
        job.status = "completed";
        job.runs = runs;
        job.completedAt = new Date().toISOString();
      })
      .catch((err) => {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        job.completedAt = new Date().toISOString();
      });

    return { jobId, async: true, total: list.length };
  });

  app.get("/api/runs", async () => store.listRuns(100));

  app.get("/api/runs/:runId", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    if (!isSafeRunId(runId)) return reply.notFound("run not found");
    const run = await store.getRun(runId);
    if (!run) return reply.notFound("run not found");
    return run;
  });

  app.get("/api/runs/:runId/diagnose", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    if (!isSafeRunId(runId)) return reply.notFound("run not found");
    const run = await store.getRun(runId);
    if (!run) return reply.notFound("run not found");
    if (run.status === "passed") {
      return { runId, status: run.status, failureKind: null, suggestions: [] as string[] };
    }
    const stepMsg = run.steps.find((s) => s.message)?.message;
    const assertionMsg = run.assertions.find((a) => !a.passed)?.message;
    const failureKind =
      run.metrics?.failureKind ??
      classifyFailure({ stepError: stepMsg, assertionMessage: assertionMsg });
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

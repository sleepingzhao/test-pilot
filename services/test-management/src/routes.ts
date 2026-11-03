import type { FastifyInstance } from "fastify";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { assertPlaywrightReady, recordSession } from "@testpilot/recorder-web";
import { runTestIR, type RunResult } from "@testpilot/runner-web";
import { snapshotPageContext } from "@testpilot/context-web";
import { planDraft, suggestAssertionsForTest } from "@testpilot/planner";
import { computeIRHash, validateSemantics, validateTestIR } from "@testpilot/test-ir";
import { classifyFailure } from "@testpilot/evidence";
import { chromium } from "playwright";
import type { FileStore, RecordJob, StoredRun, StoredTest } from "./store.js";
import {
  buildRunEnvironment,
  pilotBaseUrl,
  pilotSecretsConfigured,
  testNeedsPilotSecrets,
  uniqueTargetBaseUrls,
  DEMO_BASE_URL,
} from "./run-env.js";

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
  const next: StoredTest = { ...test, irHash, updatedAt: new Date().toISOString() };
  if (opts?.approving) {
    next.approvalStatus = "approved";
    next.approvedAt = new Date().toISOString();
  }
  return next;
}

async function loadPilotBaseline(): Promise<{ manualRegressionMinutes?: number; notes?: string } | null> {
  try {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
    const raw = await readFile(join(repoRoot, "docs/pilot-baseline.json"), "utf8");
    return JSON.parse(raw) as { manualRegressionMinutes?: number; notes?: string };
  } catch {
    return null;
  }
}

/** Sum duration of runs started within 2 minutes of the latest run (typical「运行全部」批次). */
function estimateLastBatchDurationMs(runs: StoredRun[]): number | null {
  if (runs.length === 0) return null;
  const sorted = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const newestStart = new Date(sorted[0].startedAt).getTime();
  const batch = sorted.filter((r) => newestStart - new Date(r.startedAt).getTime() <= 120_000);
  if (batch.length === 0) return null;
  return batch.reduce((s, r) => s + (r.metrics?.durationMs ?? 0), 0);
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

  app.get("/api/projects/:projectId/tests", async () => store.listTests());

  app.get("/api/tests/:testId", async (req, reply) => {
    const { testId } = req.params as { testId: string };
    const test = await store.getTest(testId);
    if (!test) return reply.notFound("test not found");
    return test;
  });

  app.put("/api/tests/:testId", async (req, reply) => {
    const { testId } = req.params as { testId: string };
    const body = req.body as { title?: string; ir?: StoredTest["ir"] };
    const existing = await store.getTest(testId);
    if (!existing) return reply.notFound("test not found");
    const updated = stampTestMeta({
      ...existing,
      title: body.title ?? existing.title,
      ir: body.ir ?? existing.ir,
      approvalStatus: body.ir ? "draft" : existing.approvalStatus,
      updatedAt: existing.updatedAt,
    });
    const v = validateTestIR(updated.ir);
    if (!v.ok) return reply.code(400).send({ issues: v.issues });
    await store.saveTest(updated);
    return updated;
  });

  app.delete("/api/tests/:testId", async (req) => {
    const { testId } = req.params as { testId: string };
    await store.deleteTest(testId);
    return { ok: true };
  });

  app.post("/api/tests/:testId/approve", async (req, reply) => {
    const { testId } = req.params as { testId: string };
    const test = await store.getTest(testId);
    if (!test) return reply.notFound("test not found");
    const hasPlaceholder = test.ir.assertions.some((a) =>
      String((a as { contains?: string }).contains ?? "").includes("REPLACE"),
    );
    if (hasPlaceholder) return reply.code(400).send({ error: "请先完善断言再批准" });
    const semantic = validateSemantics(test.ir);
    if (semantic.length) return reply.code(400).send({ issues: semantic });
    const approved = stampTestMeta(test, { approving: true });
    await store.saveTest(approved);
    return approved;
  });

  app.post("/api/tests/:testId/suggest-assertions", async (req, reply) => {
    const { testId } = req.params as { testId: string };
    const test = await store.getTest(testId);
    if (!test) return reply.notFound("test not found");
    const { assertions, uncertainties } = suggestAssertionsForTest(test.title, test.ir);
    return { assertions, uncertainties, irHash: computeIRHash(test.ir) };
  });

  app.get("/api/environment", async () => {
    const project = store.project();
    const pilotUrl = pilotBaseUrl();
    const demoReachable = await checkTargetReachable(DEMO_BASE_URL);
    const pilotReachable = await checkTargetReachable(pilotUrl);
    return {
      demoUrl: project.defaultBaseUrl,
      demoReachable,
      pilotUrl,
      pilotReachable,
      pilotSecretsConfigured: pilotSecretsConfigured(),
      apiVersion: "0.2.0",
    };
  });

  app.get("/api/metrics/summary", async () => {
    const runs = await store.listRuns(100);
    const passed = runs.filter((r) => r.status === "passed").length;
    const totalMs = runs.reduce((s, r) => s + (r.metrics?.durationMs ?? 0), 0);
    const tests = await store.listTests();
    const approved = tests.filter((t) => t.approvalStatus === "approved").length;
    const baseline = await loadPilotBaseline();
    const lastBatchMs = estimateLastBatchDurationMs(runs);
    return {
      runCount: runs.length,
      passRate: runs.length ? passed / runs.length : 0,
      avgDurationMs: runs.length ? Math.round(totalMs / runs.length) : 0,
      llmTokensTotal: 0,
      approvedTestCount: approved,
      lastBatchDurationMs: lastBatchMs,
      pilotBaselineMinutes: baseline?.manualRegressionMinutes ?? null,
      pilotBaselineNotes: baseline?.notes ?? null,
    };
  });

  app.get("/api/batch-runs/:jobId", async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const job = batchJobs.get(jobId);
    if (!job) return reply.notFound("batch job not found");
    return job;
  });

  app.post("/api/projects/:projectId/runs", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = (req.body ?? {}) as { testId?: string; baseUrl?: string; includeDraft?: boolean };
    const project = store.project();
    const baseUrl = body.baseUrl ?? project.defaultBaseUrl;

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
    for (const url of uniqueTargetBaseUrls(list, runEnv)) {
      if (!(await checkTargetReachable(url))) {
        return reply.code(503).send({ error: `目标环境不可达: ${url}` });
      }
    }
    if (list.some((t) => testNeedsPilotSecrets(t.ir)) && !pilotSecretsConfigured()) {
      return reply.code(503).send({
        error:
          "试点登录用例需要配置仓库根目录 .env（见 .env.example）：TESTPILOT_ENV_ADMIN_PHONE / TESTPILOT_ENV_ADMIN_PASSWORD",
      });
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
    const run = await store.getRun(runId);
    if (!run) return reply.notFound("run not found");
    return run;
  });

  app.get("/api/runs/:runId/diagnose", async (req, reply) => {
    const { runId } = req.params as { runId: string };
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
    } else if (failureKind === "PRODUCT_DEFECT") {
      suggestions.push("断言与产品行为不一致：确认是否为真实缺陷或断言过时。");
    } else {
      suggestions.push("下载 Trace 与 network.json；必要时重新录制步骤。");
    }
    return {
      runId,
      status: run.status,
      failureKind,
      stepError: stepMsg,
      assertionMessage: assertionMsg,
      suggestions,
      llmUsed: false,
    };
  });

  app.post("/api/plan", async (req, reply) => {
    const body = req.body as { goal: string; url?: string };
    if (!body.goal?.trim()) return reply.code(400).send({ error: "goal is required" });
    const project = store.project();
    const url = body.url ?? project.defaultBaseUrl;
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
    const draft = planDraft({ goal: body.goal.trim(), context });
    return { draft, contextElementCount: context.elements.length, llmTokensUsed: 0 };
  });

  app.get("/api/runs/:runId/artifacts/*", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const wildcard = (req.params as { "*": string })["*"];
    const run = await store.getRun(runId);
    if (!run) return reply.notFound("run not found");
    const artifact = run.artifacts.artifacts.find((a) => a.path.endsWith(wildcard));
    const runDir = run.artifacts?.dir ?? join(artifactsRoot, "runs", runId);
    let filePath = artifact?.path ?? join(runDir, wildcard);
    if (!existsSync(filePath)) {
      if (wildcard === "network.json") {
        await mkdir(runDir, { recursive: true });
        filePath = join(runDir, "network.json");
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
    const body = req.body as { url?: string; testId?: string; title?: string };
    if (!body?.url?.trim()) {
      return reply.code(400).send({ error: "请提供录制起始 URL" });
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(body.url.trim());
    } catch {
      return reply.code(400).send({ error: "URL 格式无效" });
    }
    const testId = (body.testId?.trim() || `rec-${Date.now()}`).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(testId)) {
      return reply.code(400).send({ error: "testId 只能包含小写字母、数字和连字符" });
    }

    const jobId = `rec_${Date.now()}`;
    const job: RecordJob = { id: jobId, status: "running", startedAt: new Date().toISOString() };
    recordJobs.set(jobId, job);
    recordLock = true;

    void (async () => {
      try {
        await assertPlaywrightReady();
        const { ir, warnings } = await recordSession({ url: parsedUrl.toString(), testId });
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
    const job = recordJobs.get(jobId);
    if (!job) return reply.notFound("job not found");
    return job;
  });
}

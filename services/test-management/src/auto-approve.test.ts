import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sensible from "@fastify/sensible";
import Fastify from "fastify";
import type { TestIR } from "@testpilot/test-ir";
import { saveDetection } from "./detection.js";
import { sessionIdForDetect } from "./session-layout.js";
import { registerRoutes } from "./routes.js";
import { FileStore } from "./store.js";

const ENV_KEYS = [
  "TESTPILOT_LLM_API_KEY",
  "TESTPILOT_UI_ASSERT_TIMEOUT_MS",
  "TESTPILOT_AUTO_APPROVE",
  "TESTPILOT_ALLOWED_TARGETS",
  "TESTPILOT_REAL_BASE_URL",
  "TESTPILOT_ENV_REAL_ENTERPRISE_ID",
  "TESTPILOT_ENV_REAL_USER_ID",
  "TESTPILOT_ENV_REAL_PASSWORD",
  "TESTPILOT_PILOT_BASE_URL",
] as const;

async function withFixture(
  fn: (ctx: { baseUrl: string; store: FileStore; dataRoot: string; app: Fastify.FastifyInstance }) => Promise<void>,
  env: Record<string, string | undefined>,
  handler?: RequestListener,
): Promise<void> {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  const server = createServer(handler ?? ((req, res) => {
    if ((req.url ?? "/") === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><body><h1>操作成功</h1></body></html>");
      return;
    }
    res.writeHead(404);
    res.end();
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  process.env.TESTPILOT_ALLOWED_TARGETS = baseUrl;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const root = await mkdtemp(join(tmpdir(), "testpilot-auto-approve-"));
  const dataRoot = join(root, "data");
  const store = new FileStore(dataRoot);
  await store.init();
  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, join(root, "artifacts"), dataRoot);
  await app.ready();
  try {
    await fn({ baseUrl, store, dataRoot, app });
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function draftIr(testId: string, baseUrl: string, contains: string): TestIR {
  return {
    id: testId,
    version: 1,
    platform: "web",
    baseUrl,
    steps: [{ id: "open", action: "navigate", path: "/" }],
    assertions: [{ id: "ok", type: "ui", contains, oracle: "human-approved" }],
  };
}

async function saveDraft(store: FileStore, ir: TestIR): Promise<void> {
  await store.saveTest({
    id: ir.id,
    projectId: "default",
    title: "auto approve",
    ir,
    approvalStatus: "draft",
    updatedAt: new Date().toISOString(),
  });
}

test("auto-approve: passing trial with a strong assertion approves and audits", async () => {
  await withFixture(
    async ({ baseUrl, store, dataRoot, app }) => {
      const testId = "auto-strong";
      const ir = draftIr(testId, baseUrl, "操作成功");
      await saveDraft(store, ir);
      const res = await app.inject({
        method: "POST",
        url: `/api/tests/${testId}/trial-run`,
        payload: { ir },
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json() as { test?: { approvalStatus?: string; autoApproved?: boolean; approvedBy?: string } };
      assert.equal(body.test?.approvalStatus, "approved");
      assert.equal(body.test?.autoApproved, true);
      assert.equal(body.test?.approvedBy, "auto:testpilot");
      const stored = await store.getTest(testId);
      assert.equal(stored?.approvalStatus, "approved");
      assert.equal(stored?.autoApproved, true);
      const audit = await readFile(join(dataRoot, "audit.jsonl"), "utf8");
      assert.match(audit, /"actor":"auto:testpilot"/);
      assert.match(audit, /"auto":true/);
    },
    { TESTPILOT_AUTO_APPROVE: "1" },
  );
});

test("auto-approve: weak assertion stays draft even when the trial passes", async () => {
  await withFixture(
    async ({ baseUrl, store, app }) => {
      const testId = "auto-weak";
      const ir = draftIr(testId, baseUrl, "成功");
      await saveDraft(store, ir);
      const res = await app.inject({
        method: "POST",
        url: `/api/tests/${testId}/trial-run`,
        payload: { ir },
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json() as { test?: unknown };
      assert.equal(body.test, undefined);
      const stored = await store.getTest(testId);
      assert.equal(stored?.approvalStatus, "draft");
      assert.equal(stored?.autoApproved, undefined);
    },
    { TESTPILOT_AUTO_APPROVE: "1" },
  );
});

test("auto-approve: disabled flag keeps a passing draft unapproved", async () => {
  await withFixture(
    async ({ baseUrl, store, app }) => {
      const testId = "auto-off";
      const ir = draftIr(testId, baseUrl, "操作成功");
      await saveDraft(store, ir);
      const res = await app.inject({
        method: "POST",
        url: `/api/tests/${testId}/trial-run`,
        payload: { ir },
      });
      assert.equal(res.statusCode, 200, res.body);
      const stored = await store.getTest(testId);
      assert.equal(stored?.approvalStatus, "draft");
      assert.equal(stored?.autoApproved, undefined);
    },
    { TESTPILOT_AUTO_APPROVE: undefined },
  );
});

for (const createsTicket of [false, true]) {
  test(`requirement trial keeps its original assertion when ticket creation ${createsTicket ? "succeeds" : "fails despite a toast"}`, async () => {
    await withFixture(async ({ baseUrl, store, app }) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/requirement-flow",
        payload: { target: "custom", customUrl: baseUrl, text: "提交工单" },
      });
      assert.equal(res.statusCode, 200, res.body);
      const { test: result, trial, generation } = res.json();
      const stored = await store.getTest(result.id);
      assert.ok(stored);
      const original = [{ id: "ticket-submitted", type: "ui", contains: "工单已提交", oracle: "human-approved" }];
      assert.deepEqual(stored.ir.assertions, original);
      assert.deepEqual(result.ir.assertions, original);
      assert.equal(trial.run.status, createsTicket ? "passed" : "failed");
      assert.equal(trial.run.assertions[0].assertionId, "ticket-submitted");
      assert.equal(trial.run.assertions[0].passed, createsTicket);
      assert.equal(stored.approvalStatus, createsTicket ? "approved" : "draft");
      assert.deepEqual((await store.listRuns()).map(run => run.runId), [trial.run.runId]);
      assert.deepEqual(stored.plannerNotes, generation.uncertainties);
      assert.equal(stored.plannerNotes?.some(note => note.includes("已受理请求")), !createsTicket);
    }, { TESTPILOT_AUTO_APPROVE: "1", TESTPILOT_UI_ASSERT_TIMEOUT_MS: "500" }, (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><button>保存</button><p role="alert"></p><ul></ul>
        <script>document.querySelector('button').onclick = () => {
          document.querySelector('p').textContent = '已受理请求';
          document.querySelector('ul').innerHTML = ${JSON.stringify(createsTicket ? '<li>工单已提交</li>' : '')};
        };</script>`);
    });
  });
}

for (const scenario of ["missing", "failed", "passed"] as const) {
  test(`suite and single trial enforce the same search pair when filtering is ${scenario}`, async () => {
    const route = scenario === "missing" ? "/alpha/" : "/members/";
    let filteringWorks = scenario === "passed";
    await withFixture(async ({ baseUrl, app, store, dataRoot }) => {
      process.env.TESTPILOT_REAL_BASE_URL = baseUrl;
      const id = `detect_${scenario}`;
      await saveDetection(dataRoot, {
        id, sessionId: sessionIdForDetect(id), target: "real", url: baseUrl, createdAt: new Date().toISOString(),
        profile: {
          version: 1, target: { url: baseUrl, mode: "passive" }, capabilities: [], questions: [], signals: [],
          surfaces: [{ route, elements: [
            { role: "heading", name: "成员目录", testId: "directory" },
            { role: "input", placeholder: "搜索成员" },
            { role: "listitem", name: "Alpha" },
          ] }],
        },
      });
      const start = await app.inject({ method: "POST", url: `/api/detect/${id}/read-only-suite`, payload: {} });
      assert.equal(start.statusCode, 202, start.body);
      const jobUrl = `/api/read-only-suite/jobs/${start.json().jobId}`;
      let job = (await app.inject({ url: jobUrl })).json();
      const deadline = Date.now() + 60_000;
      while (job.status === "running" && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
        job = (await app.inject({ url: jobUrl })).json();
      }
      assert.equal(job.status, "completed", JSON.stringify(job));
      type Result = { testId: string; status: string; approved: boolean; message?: string };
      const hit = (job.results as Result[]).find(result => result.testId.endsWith("-search-match"));
      const filter = (job.results as Result[]).find(result => result.testId.endsWith("-search-none"));
      assert.equal(filter?.status, scenario === "missing" ? undefined : scenario, JSON.stringify(job));
      assert.ok(hit);
      assert.equal(hit.status, "passed", hit.message);
      assert.equal(hit.approved, scenario === "passed", hit.message);
      const saved = await store.getTest(hit.testId);
      assert.ok(saved);

      const retry = async (ir: TestIR) => {
        const res = await app.inject({ method: "POST", url: `/api/tests/${ir.id}/trial-run`, payload: { ir } });
        assert.equal(res.statusCode, 200, res.body);
        return res.json();
      };
      // Re-open the hit as a draft so both entry points make their own approval decision.
      const reopen = () => app.inject({ method: "PUT", url: `/api/tests/${saved.id}`, payload: { ir: saved.ir } });
      assert.equal((await reopen()).statusCode, 200);
      const single = await retry(saved.ir);
      assert.equal(single.run.status, "passed");
      assert.equal(single.approvalNote, hit.message);
      assert.equal((await store.getTest(saved.id))?.approvalStatus, hit.approved ? "approved" : "draft");

      if (scenario === "passed") {
        filteringWorks = false;
        const pair = await store.getTest(filter!.testId);
        assert.ok(pair);
        assert.equal((await retry(pair.ir)).run.status, "failed");
        assert.equal((await reopen()).statusCode, 200);
        assert.match((await retry(saved.ir)).approvalNote, /重新试跑/);
        assert.equal((await store.getTest(saved.id))?.approvalStatus, "draft");
      }
    }, {
      TESTPILOT_AUTO_APPROVE: "1",
      TESTPILOT_UI_ASSERT_TIMEOUT_MS: "500",
      TESTPILOT_ENV_REAL_ENTERPRISE_ID: "fixture",
      TESTPILOT_ENV_REAL_USER_ID: "fixture",
      TESTPILOT_ENV_REAL_PASSWORD: "fixture",
    }, (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<h1 data-testid="directory">成员目录</h1><input placeholder="搜索成员"><ul><li>Alpha</li></ul>
        <script>document.querySelector('input').onkeydown = e => {
          if (${filteringWorks} && e.key === 'Enter' && e.target.value === 'zzqqxx') document.querySelector('li').remove();
        };</script>`);
    });
  });
}

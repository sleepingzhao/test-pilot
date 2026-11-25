import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sensible from "@fastify/sensible";
import Fastify from "fastify";
import type { TestIR } from "@testpilot/test-ir";
import { registerRoutes } from "./routes.js";
import { FileStore } from "./store.js";

const ENV_KEYS = [
  "TESTPILOT_LLM_API_KEY",
  "TESTPILOT_UI_ASSERT_TIMEOUT_MS",
  "TESTPILOT_AUTO_APPROVE",
  "TESTPILOT_ALLOWED_TARGETS",
  "TESTPILOT_REAL_BASE_URL",
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

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerRoutes,
  reclassifyDraftAssertionFailures,
  resolveRequirementAssertions,
  titleFromRequirement,
} from "./routes.js";
import { FileStore, type StoredRun } from "./store.js";

test("POST /api/requirement-flow requires text (negative)", async () => {
  const root = await mkdtemp(join(tmpdir(), "tp-req-"));
  const store = new FileStore(join(root, "data"));
  await store.init();
  const app = Fastify();
  await registerRoutes(app, store, join(root, "artifacts"), join(root, "data"));
  const res = await app.inject({
    method: "POST",
    url: "/api/requirement-flow",
    payload: { target: "demo" },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("real environment requirement generation is blocked (negative)", async () => {
  const root = await mkdtemp(join(tmpdir(), "tp-req-real-"));
  const store = new FileStore(join(root, "data"));
  await store.init();
  const app = Fastify();
  await registerRoutes(app, store, join(root, "artifacts"), join(root, "data"));
  const res = await app.inject({
    method: "POST",
    url: "/api/requirement-flow",
    payload: { target: "real", text: "登录后执行只读检查" },
  });
  assert.equal(res.statusCode, 400);
  assert.match(String(res.json().error ?? ""), /系统画像/);
  await app.close();
});

test("derives a readable title from the first requirement sentence", () => {
  assert.equal(
    titleFromRequirement("登录后点击提交工单输入信息后可以成功创建工单（不用提交附件）"),
    "登录后点击提交工单输入信息后可以成功创建工单",
  );
  assert.equal(titleFromRequirement("第一句话。第二句话"), "第一句话");
  assert.equal(titleFromRequirement("   "), "需求草案");
});

test("pilot form submit asserts the create request instead of a transient toast", () => {
  const fallback = [
    { id: "ticket-submitted", type: "ui" as const, contains: "工单已提交", oracle: "human-approved" as const },
  ];
  const out = resolveRequirementAssertions(true, fallback);
  assert.equal(out.length, 1);
  const assertion = out[0] as { type: string; requestRef?: string; expect?: Record<string, unknown> };
  assert.equal(assertion.type, "api");
  assert.equal(assertion.requestRef, "pilot-ticket-submit");
  assert.deepEqual(assertion.expect, { statusCode: 200, requestBodyContains: "TestPilot-" });
  assert.equal(resolveRequirementAssertions(false, fallback), fallback);
});

test("draft assertion misses are not reported as product defects", () => {
  const run = {
    runId: "run_1",
    testId: "t1",
    testVersion: 1,
    status: "failed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    steps: [],
    assertions: [{ assertionId: "ticket-submitted", passed: false, errorKind: "PRODUCT_DEFECT" }],
    artifacts: { screenshots: [], traces: [], notes: undefined } as unknown as StoredRun["artifacts"],
    metrics: { durationMs: 1, llmTokensUsed: 0, failureKind: "PRODUCT_DEFECT", attemptCount: 1 },
    projectId: "default",
    testTitle: "draft",
    trial: true,
  } as StoredRun;

  const draft = reclassifyDraftAssertionFailures(run, false);
  assert.equal(draft.metrics?.failureKind, "ASSERTION_ORACLE");
  assert.equal(draft.assertions[0]?.errorKind, "ASSERTION_ORACLE");

  const approved = reclassifyDraftAssertionFailures(run, true);
  assert.equal(approved.metrics?.failureKind, "PRODUCT_DEFECT");
  assert.equal(approved.assertions[0]?.errorKind, "PRODUCT_DEFECT");
});

test("requirement job reports progress and exposes validation failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "tp-req-job-"));
  const store = new FileStore(join(root, "data"));
  await store.init();
  const app = Fastify();
  await registerRoutes(app, store, join(root, "artifacts"), join(root, "data"));
  try {
    const start = await app.inject({
      method: "POST",
      url: "/api/requirement-flow/jobs",
      payload: { target: "demo" },
    });
    assert.equal(start.statusCode, 202);
    const { jobId } = start.json() as { jobId: string };
    let job: { status: string; error?: string; stage: string } = { status: "running", stage: "" };
    for (let i = 0; i < 50; i++) {
      const res = await app.inject({ method: "GET", url: `/api/requirement-flow/jobs/${jobId}` });
      job = res.json() as typeof job;
      if (job.status !== "running") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(job.status, "failed");
    assert.match(job.error ?? "", /需求描述/);
  } finally {
    await app.close();
  }
});

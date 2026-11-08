import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sensible from "@fastify/sensible";
import type { SystemProfile } from "@testpilot/detect";
import Fastify from "fastify";
import {
  latestDetection,
  listDetections,
  readDetection,
  runDetection,
  saveDetection,
  type DetectionRecord,
} from "./detection.js";
import { registerRoutes } from "./routes.js";
import { readSessionMeta } from "./session-layout.js";
import { FileStore } from "./store.js";

const profile: SystemProfile = {
  version: 1,
  target: { url: "http://127.0.0.1:4173/", mode: "passive" },
  surfaces: [{ route: "/", title: "练习环境", elements: [] }],
  signals: [
    {
      id: "dom.table",
      strength: 1,
      evidence: [{ id: "ev-table", kind: "dom", summary: "可见表格", route: "/" }],
    },
  ],
  capabilities: [
    {
      id: "crud",
      confidence: 0.9,
      evidenceIds: ["ev-table"],
      signals: ["dom.table"],
      requires: ["test-data"],
      unknowns: [],
    },
  ],
  questions: [],
};

function fakeDeps() {
  return {
    openPage: async () => ({ page: {} as never, close: async () => undefined }),
    collect: async () => profile,
  };
}

test("runDetection stores a detect session and returns the profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-detect-"));
  const dataRoot = join(root, "data");
  const stages: string[] = [];
  try {
    const record = await runDetection(
      { dataRoot, target: "demo", demoUrl: "http://127.0.0.1:4173" },
      (stage) => stages.push(stage),
      fakeDeps(),
    );
    assert.equal(record.target, "demo");
    assert.equal(record.profile.capabilities[0]?.id, "crud");
    assert.ok(stages.includes("完成"), stages.join(","));

    const stored = await readDetection(dataRoot, record.id);
    assert.deepEqual(stored, record);
    assert.equal((await listDetections(dataRoot)).length, 1);
    assert.equal((await latestDetection(dataRoot, "demo"))?.id, record.id);

    const meta = await readSessionMeta(dataRoot, record.sessionId);
    assert.equal(meta?.kind, "detect");
    assert.equal(meta?.target, "demo");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runDetection rejects a custom target outside the allow-list", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-detect-"));
  const dataRoot = join(root, "data");
  try {
    await assert.rejects(
      runDetection(
        {
          dataRoot,
          target: "custom",
          customUrl: "https://not-allowed.invalid",
          demoUrl: "http://127.0.0.1:4173",
        },
        () => undefined,
        fakeDeps(),
      ),
      /允许列表/,
    );
    assert.equal((await listDetections(dataRoot)).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("latestDetection filters by target and custom origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-detect-"));
  const dataRoot = join(root, "data");
  const base: Omit<DetectionRecord, "id" | "sessionId" | "target" | "url" | "createdAt"> = {
    profile,
  };
  try {
    await saveDetection(dataRoot, {
      ...base,
      id: "detect_demo",
      sessionId: "session_detect_demo",
      target: "demo",
      url: "http://127.0.0.1:4173/",
      createdAt: "2026-11-08T10:00:00.000Z",
    });
    await saveDetection(dataRoot, {
      ...base,
      id: "detect_custom",
      sessionId: "session_detect_custom",
      target: "custom",
      url: "http://127.0.0.1:9999/",
      createdAt: "2026-11-08T10:01:00.000Z",
    });

    assert.equal((await latestDetection(dataRoot, "demo"))?.id, "detect_demo");
    assert.equal(
      (await latestDetection(dataRoot, "custom", "http://127.0.0.1:9999/other"))?.id,
      "detect_custom",
    );
    assert.equal(await latestDetection(dataRoot, "custom", "http://127.0.0.1:8888"), undefined);
    assert.equal(await readDetection(dataRoot, "../escape"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detection API serves profiles and fails an invalid target job", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-detect-api-"));
  const dataRoot = join(root, "data");
  const store = new FileStore(dataRoot);
  await store.init();
  await saveDetection(dataRoot, {
    id: "detect_api",
    sessionId: "session_detect_api",
    target: "demo",
    url: "http://127.0.0.1:4173/",
    createdAt: "2026-11-08T10:00:00.000Z",
    profile,
  });

  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, join(root, "artifacts"), dataRoot);
  await app.ready();

  try {
    const latest = await app.inject({ method: "GET", url: "/api/detect/latest?target=demo" });
    assert.equal(latest.statusCode, 200);
    assert.equal((latest.json() as { record: DetectionRecord }).record.id, "detect_api");

    const list = await app.inject({ method: "GET", url: "/api/detect" });
    assert.equal(list.statusCode, 200);
    assert.equal((list.json() as { detections: DetectionRecord[] }).detections.length, 1);

    const detail = await app.inject({ method: "GET", url: "/api/detect/detect_api" });
    assert.equal(detail.statusCode, 200);
    assert.equal((detail.json() as DetectionRecord).profile.capabilities[0]?.id, "crud");

    const created = await app.inject({
      method: "POST",
      url: "/api/detect/jobs",
      payload: { target: "custom", customUrl: "https://not-allowed.invalid" },
    });
    assert.equal(created.statusCode, 202);
    const { jobId } = created.json() as { jobId: string };
    let job: { status: string; error?: string } | undefined;
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const res = await app.inject({ method: "GET", url: `/api/detect/jobs/${jobId}` });
      job = res.json() as { status: string; error?: string };
      if (job.status !== "running") break;
    }
    assert.equal(job?.status, "failed");
    assert.match(String(job?.error ?? ""), /允许列表/);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

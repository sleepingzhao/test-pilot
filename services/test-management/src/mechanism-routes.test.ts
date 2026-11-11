import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sensible from "@fastify/sensible";
import type { SystemProfile } from "@testpilot/detect";
import Fastify from "fastify";
import { saveDetection, type DetectionRecord } from "./detection.js";
import { PILOT_REAL_BLOCKER } from "./mechanisms.js";
import { registerRoutes } from "./routes.js";
import { FileStore } from "./store.js";

const demoProfile: SystemProfile = {
  version: 1,
  target: { url: "http://127.0.0.1:4173/", mode: "passive" },
  surfaces: [{ route: "/files", elements: [] }],
  signals: [],
  capabilities: [
    {
      id: "file-media",
      confidence: 0.8,
      evidenceIds: [],
      signals: ["dom.file-input"],
      requires: ["upload-fixture"],
      unknowns: [],
    },
  ],
  questions: [],
};

const crudOnlyProfile: SystemProfile = {
  ...demoProfile,
  capabilities: [
    {
      id: "crud",
      confidence: 0.9,
      evidenceIds: [],
      signals: [],
      requires: [],
      unknowns: [],
    },
  ],
};

async function setupApp() {
  const root = await mkdtemp(join(tmpdir(), "testpilot-mech-route-"));
  const dataRoot = join(root, "data");
  const store = new FileStore(dataRoot);
  await store.init();
  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, join(root, "artifacts"), dataRoot);
  await app.ready();
  return { app, store, dataRoot, root };
}

async function saveRecord(dataRoot: string, partial: Partial<DetectionRecord> & Pick<DetectionRecord, "id" | "target" | "profile">) {
  const record: DetectionRecord = {
    sessionId: `session_${partial.id}`,
    url: "http://127.0.0.1:4173/",
    createdAt: "2026-11-12T00:00:00.000Z",
    ...partial,
  };
  await saveDetection(dataRoot, record);
  return record;
}

test("GET /api/detect/:id/mechanisms returns 404 for unknown detection", async () => {
  const { app, root } = await setupApp();
  try {
    const res = await app.inject({ method: "GET", url: "/api/detect/missing-id/mechanisms" });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("GET mechanisms for demo file-media record is runnable with defaults", async () => {
  const { app, dataRoot, root } = await setupApp();
  try {
    await saveRecord(dataRoot, {
      id: "detect_demo_fm",
      target: "demo",
      profile: demoProfile,
    });
    const res = await app.inject({ method: "GET", url: "/api/detect/detect_demo_fm/mechanisms" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      mechanisms: Array<{ runnable: boolean; scenarios: Array<{ id: string }>; context: { uploadRef: string } }>;
    };
    assert.equal(body.mechanisms[0]?.runnable, true);
    assert.deepEqual(body.mechanisms[0]?.scenarios.map((s) => s.id), ["happy"]);
    assert.equal(body.mechanisms[0]?.context.uploadRef, "fixture.samplePng");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("GET mechanisms for real target is not runnable", async () => {
  const { app, dataRoot, root } = await setupApp();
  try {
    await saveRecord(dataRoot, {
      id: "detect_real_fm",
      target: "real",
      profile: demoProfile,
    });
    const res = await app.inject({ method: "GET", url: "/api/detect/detect_real_fm/mechanisms" });
    const body = res.json() as { mechanisms: Array<{ runnable: boolean; blockers: string[] }> };
    assert.equal(body.mechanisms[0]?.runnable, false);
    assert.ok(body.mechanisms[0]?.blockers.includes(PILOT_REAL_BLOCKER));
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("POST file-media draft saves mechanism channel draft without paths", async () => {
  const { app, dataRoot, store, root } = await setupApp();
  const prevFixture = process.env.TESTPILOT_FIXTURE_SAMPLEPNG;
  process.env.TESTPILOT_FIXTURE_SAMPLEPNG = "sample.png";
  try {
    await saveRecord(dataRoot, {
      id: "detect_post_fm",
      target: "demo",
      profile: demoProfile,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/mechanisms/file-media/draft",
      payload: { detectionId: "detect_post_fm", scenario: "happy" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      test: { id: string; approvalStatus: string; sourceChannel?: string; ir: unknown };
    };
    assert.equal(body.test.approvalStatus, "draft");
    assert.equal(body.test.sourceChannel, "mechanism");
    const raw = JSON.stringify(body.test.ir);
    assert.equal(raw.includes("/Users/"), false);
    assert.equal(raw.includes("fixture/"), false);
    assert.match(body.test.id, /^mechanism-file-media-happy-/);
    const stored = await store.getTest(body.test.id);
    assert.equal(stored?.approvalStatus, "draft");
    assert.equal(stored?.sourceChannel, "mechanism");
  } finally {
    if (prevFixture === undefined) delete process.env.TESTPILOT_FIXTURE_SAMPLEPNG;
    else process.env.TESTPILOT_FIXTURE_SAMPLEPNG = prevFixture;
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("POST file-media draft rejects unknown detection, bad scenario, and real target", async () => {
  const { app, dataRoot, root } = await setupApp();
  try {
    await saveRecord(dataRoot, {
      id: "detect_real_post",
      target: "real",
      profile: demoProfile,
    });
    const missing = await app.inject({
      method: "POST",
      url: "/api/mechanisms/file-media/draft",
      payload: { detectionId: "not_there" },
    });
    assert.equal(missing.statusCode, 404);

    const real = await app.inject({
      method: "POST",
      url: "/api/mechanisms/file-media/draft",
      payload: { detectionId: "detect_real_post" },
    });
    assert.equal(real.statusCode, 400);

    await saveRecord(dataRoot, {
      id: "detect_low_fm",
      target: "demo",
      profile: crudOnlyProfile,
    });
    const blocked = await app.inject({
      method: "POST",
      url: "/api/mechanisms/file-media/draft",
      payload: { detectionId: "detect_low_fm", scenario: "happy" },
    });
    assert.equal(blocked.statusCode, 400);

    await saveRecord(dataRoot, {
      id: "detect_bad_scenario",
      target: "demo",
      profile: demoProfile,
    });
    const badScenario = await app.inject({
      method: "POST",
      url: "/api/mechanisms/file-media/draft",
      payload: { detectionId: "detect_bad_scenario", scenario: "oversize" },
    });
    assert.equal(badScenario.statusCode, 400);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("POST trial on custom target is refused", async () => {
  const { app, dataRoot, root } = await setupApp();
  try {
    await saveRecord(dataRoot, {
      id: "detect_custom_fm",
      target: "custom",
      profile: demoProfile,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/mechanisms/file-media/draft",
      payload: { detectionId: "detect_custom_fm", trial: true },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: string };
    assert.match(body.error, /练习环境/);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

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

const noLlm = async () => ({
  used: false,
  summary: "",
  capabilities: [],
  questions: [],
  tokensUsed: 0,
  error: "test",
});

function fakeDeps() {
  return {
    openPage: async () => ({ page: {} as never, close: async () => undefined }),
    collect: async () => profile,
    analyze: noLlm,
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

test("real target strips page text from the stored profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-detect-real-"));
  const dataRoot = join(root, "data");
  const profileWithText: SystemProfile = {
    ...profile,
    surfaces: [
      {
        route: "/welcome",
        title: "真实系统标题",
        elements: [{ role: "button", name: "人名" }],
      },
    ],
    signals: [
      {
        id: "dom.table",
        strength: 1,
        evidence: [{ id: "ev-real", kind: "dom", summary: "可见表格「真实项目」", route: "/welcome" }],
      },
    ],
  };
  try {
    const record = await runDetection(
      {
        dataRoot,
        target: "real",
        realUrl: "http://127.0.0.1:4173",
        demoUrl: "http://127.0.0.1:4173",
      },
      () => undefined,
      {
        openPage: async () => ({ page: {} as never, close: async () => undefined }),
        collect: async () => profileWithText,
        analyze: noLlm,
      },
    );
    assert.equal(record.target, "real");
    assert.equal(record.url, "http://127.0.0.1:4173");
    assert.equal(record.profile.surfaces[0]?.title, undefined);
    assert.equal(record.profile.surfaces[0]?.elements[0]?.name, undefined);
    assert.equal(record.profile.signals[0]?.evidence[0]?.summary, "dom.table");
    const stored = await readDetection(dataRoot, record.id);
    assert.equal(stored?.profile.surfaces[0]?.elements[0]?.name, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real target without a configured URL fails (negative)", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-detect-real-"));
  const dataRoot = join(root, "data");
  try {
    await assert.rejects(
      runDetection(
        {
          dataRoot,
          target: "real",
          demoUrl: "http://127.0.0.1:4173",
        },
        () => undefined,
        fakeDeps(),
      ),
      /未配置真实环境地址/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LLM capabilities are merged and the evidence digest is not persisted", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-detect-llm-"));
  const dataRoot = join(root, "data");
  const collected: SystemProfile = {
    ...profile,
    capabilities: [
      ...profile.capabilities,
      {
        id: "agent",
        confidence: 0.5,
        evidenceIds: ["ev-agent"],
        signals: ["dom.agent-chat"],
        requires: ["trace-source"],
        unknowns: [],
      },
    ],
    evidence: {
      pages: [
        {
          route: "/mexusclaw",
          text: "工具 技能 MCP",
          elements: [{ role: "button", name: "小智" }],
        },
      ],
      frames: [{ route: "/mexusclaw", text: "内置工具 64 技能 13", elements: [] }],
      endpoints: [{ method: "GET", path: "/api/mexusclaw/tools", status: 200 }],
    },
  };
  try {
    const record = await runDetection(
      { dataRoot, target: "demo", demoUrl: "http://127.0.0.1:4173" },
      () => undefined,
      {
        openPage: async () => ({ page: {} as never, close: async () => undefined }),
        collect: async () => collected,
        analyze: async () => ({
          used: true,
          summary: "发现小智 Agent 平台",
          capabilities: [
            {
              id: "agent",
              label: "Agent",
              confidence: 0.9,
              evidence: ["/mexusclaw"],
              subCapabilities: ["工具调用"],
              testIdeas: ["调用计算工具"],
              unknowns: [],
            },
            {
              id: "agent-mcp",
              label: "MCP",
              confidence: 0.8,
              evidence: ["/api/mexusclaw/mcp"],
              subCapabilities: [],
              testIdeas: ["验证 MCP 连接"],
              unknowns: [],
            },
          ],
          questions: ["是否允许启用 MCP？"],
          tokensUsed: 123,
          model: "test-model",
        }),
      },
    );
    const agent = record.profile.capabilities.find((item) => item.id === "agent");
    assert.equal(agent?.source, "hybrid");
    assert.ok(agent?.testIdeas?.includes("调用计算工具"));
    assert.equal(record.profile.llmCapabilities?.[0]?.id, "agent-mcp");
    assert.deepEqual(record.profile.llmQuestions, ["是否允许启用 MCP？"]);
    assert.equal(record.profile.evidence, undefined);
    assert.equal(record.profile.llmAnalysis?.tokensUsed, 123);
    const stored = await readDetection(dataRoot, record.id);
    assert.equal(stored?.profile.evidence, undefined);
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

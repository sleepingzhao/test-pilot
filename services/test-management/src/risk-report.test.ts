import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DetectionReport } from "@testpilot/detect";
import type { TestIR } from "@testpilot/test-ir";
import { buildRiskReport, readLatestRiskReport, saveRiskReport } from "./risk-report.js";
import type { StoredTest } from "./store.js";

function profile(capabilities: DetectionReport["capabilities"], signals: DetectionReport["signals"] = []): DetectionReport {
  return {
    version: 1,
    target: { url: "http://127.0.0.1:4173", mode: "passive" },
    surfaces: [],
    signals,
    capabilities,
    questions: [],
  };
}

function cap(id: DetectionReport["capabilities"][number]["id"], confidence = 0.9, unknowns: string[] = []) {
  return { id, confidence, evidenceIds: [`ev-${id}`], signals: [], requires: [], unknowns };
}

function stored(
  id: string,
  ir: Partial<TestIR> & { steps: TestIR["steps"]; assertions: TestIR["assertions"] },
  approvalStatus: StoredTest["approvalStatus"] = "approved",
): StoredTest {
  return {
    id,
    projectId: "default",
    title: id,
    ir: { id, version: 1, platform: "web", baseUrl: "http://127.0.0.1:4173", ...ir },
    approvalStatus,
    irHash: `hash-${id}`,
    updatedAt: new Date().toISOString(),
  };
}

const uiAssertion: TestIR["assertions"] = [{ id: "ui", type: "ui", contains: "列表加载完成", oracle: "human-approved" }];

test("write capability without cleanup raises a high data-lifecycle risk", () => {
  const report = buildRiskReport({
    detectionId: "det_1",
    profile: profile([cap("crud")]),
    tests: [
      stored("crud-ui", {
        steps: [{ id: "add", action: "click", target: { name: "新建" } }],
        assertions: uiAssertion,
      }),
    ],
    targetMode: "demo",
  });
  const risk = report.risks.find((item) => item.category === "data-lifecycle");
  assert.equal(risk?.severity, "high");
  assert.deepEqual(risk?.capabilityIds, ["crud"]);
});

test("cleanup strategy clears the data-lifecycle risk", () => {
  const report = buildRiskReport({
    detectionId: "det_2",
    profile: profile([cap("crud")]),
    tests: [
      stored("crud-cleanup", {
        steps: [{ id: "add", action: "click", target: { name: "新建" } }],
        assertions: uiAssertion,
        policy: { cleanup: "always" },
        teardownSteps: [{ id: "clean", action: "request", method: "DELETE", path: "/api/items/{{id}}" }],
      }),
    ],
    targetMode: "demo",
  });
  assert.equal(report.risks.some((item) => item.category === "data-lifecycle"), false);
});

test("file-media capability without an upload test is high, with one it is not", () => {
  const missing = buildRiskReport({
    detectionId: "det_3",
    profile: profile([cap("file-media")]),
    tests: [stored("doc-ui", { steps: [{ id: "open", action: "navigate", path: "/docs" }], assertions: uiAssertion })],
    targetMode: "demo",
  });
  assert.equal(missing.risks.some((item) => item.category === "validation" && item.severity === "high"), true);

  const covered = buildRiskReport({
    detectionId: "det_3b",
    profile: profile([cap("file-media")]),
    tests: [
      stored("upload", {
        steps: [{ id: "up", action: "upload", target: { testId: "file" }, valueRef: "fixture.samplePng" }],
        assertions: uiAssertion,
      }),
    ],
    targetMode: "demo",
  });
  assert.equal(covered.risks.some((item) => item.category === "validation" && item.severity === "high"), false);
});

test("realtime capability without a second actor is a high risk", () => {
  const missing = buildRiskReport({
    detectionId: "det_4",
    profile: profile([cap("realtime-messaging")]),
    tests: [stored("chat-ui", { steps: [{ id: "open", action: "navigate", path: "/chat" }], assertions: uiAssertion })],
    targetMode: "demo",
  });
  assert.equal(missing.risks.some((item) => item.category === "realtime" && item.severity === "high"), true);

  const covered = buildRiskReport({
    detectionId: "det_4b",
    profile: profile([cap("realtime-messaging")]),
    tests: [
      stored("chat-two", {
        steps: [{ id: "open", action: "navigate", path: "/chat" }],
        assertions: [{ id: "msg", type: "event", provider: "ws", expect: { contains: "hi" }, oracle: "human-approved" }],
        actors: [{ id: "primary" }, { id: "b", account: "alt" }],
      }),
    ],
    targetMode: "demo",
  });
  assert.equal(covered.risks.some((item) => item.category === "realtime"), false);
});

test("auth capability without permission coverage is a high authz risk", () => {
  const missing = buildRiskReport({
    detectionId: "det_5",
    profile: profile([cap("auth")]),
    tests: [stored("login", { steps: [{ id: "open", action: "navigate", path: "/login" }], assertions: uiAssertion })],
    targetMode: "demo",
  });
  assert.equal(missing.risks.some((item) => item.category === "authz" && item.severity === "high"), true);

  const covered = buildRiskReport({
    detectionId: "det_5b",
    profile: profile([cap("auth")]),
    tests: [
      stored("forbidden", {
        steps: [{ id: "open", action: "navigate", path: "/admin" }],
        assertions: [{ id: "denied", type: "api", stepRef: "req", expect: { statusCode: 403 }, oracle: "api-contract" }],
      }),
    ],
    targetMode: "demo",
  });
  assert.equal(covered.risks.some((item) => item.category === "authz"), false);
});

test("high-confidence capability without coverage is a medium coverage risk", () => {
  const report = buildRiskReport({
    detectionId: "det_6",
    profile: profile([cap("search-filter", 0.9)]),
    tests: [],
    targetMode: "demo",
  });
  const risk = report.risks.find((item) => item.category === "coverage");
  assert.equal(risk?.severity, "medium");
  assert.deepEqual(risk?.capabilityIds, ["search-filter"]);
});

test("unresolved unknowns on a high-impact capability are medium", () => {
  const report = buildRiskReport({
    detectionId: "det_7",
    profile: profile([cap("workflow", 0.6, ["状态机未确认"])]),
    tests: [],
    targetMode: "demo",
  });
  const risk = report.risks.find((item) => item.category === "validation" && item.severity === "medium");
  assert.ok(risk);
  assert.ok(risk.missingInfo.includes("状态机未确认"));
});

test("UI-only write coverage is a medium reliability risk", () => {
  const report = buildRiskReport({
    detectionId: "det_8",
    profile: profile([cap("crud")]),
    tests: [
      stored("crud-ui", {
        steps: [{ id: "add", action: "click", target: { name: "保存" } }],
        assertions: uiAssertion,
        policy: { cleanup: "always" },
      }),
    ],
    targetMode: "demo",
  });
  assert.equal(report.risks.some((item) => item.category === "reliability" && item.severity === "medium"), true);
});

test("write drafts on a real target become blockers; demo does not", () => {
  const draft = stored(
    "write-draft",
    {
      steps: [{ id: "post", action: "request", method: "POST", path: "/api/items" }],
      assertions: uiAssertion,
    },
    "draft",
  );
  const real = buildRiskReport({
    detectionId: "det_9",
    profile: profile([cap("crud")]),
    tests: [draft],
    targetMode: "real",
  });
  assert.equal(real.blockers.length, 1);
  assert.match(real.blockers[0]!, /只允许只读/);

  const demo = buildRiskReport({
    detectionId: "det_9b",
    profile: profile([cap("crud")]),
    tests: [draft],
    targetMode: "demo",
  });
  assert.equal(demo.blockers.length, 0);
});

test("risk reports persist and are queried per detection", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-risk-"));
  try {
    const report = buildRiskReport({
      detectionId: "det_10",
      profile: profile([cap("search-filter")]),
      tests: [],
      targetMode: "demo",
    });
    await saveRiskReport(root, report);
    const latest = await readLatestRiskReport(root, "det_10");
    assert.equal(latest?.id, report.id);
    assert.equal(await readLatestRiskReport(root, "det_other"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("input hash is stable for identical inputs", () => {
  const args = {
    detectionId: "det_11",
    profile: profile([cap("crud")]),
    tests: [
      stored("t", { steps: [{ id: "open", action: "navigate", path: "/" }], assertions: uiAssertion }),
    ],
    targetMode: "demo" as const,
  };
  const a = buildRiskReport(args);
  const b = buildRiskReport(args);
  assert.equal(a.inputHash, b.inputHash);
  const changed = buildRiskReport({
    ...args,
    tests: [...args.tests, stored("t2", { steps: [{ id: "open", action: "navigate", path: "/x" }], assertions: uiAssertion })],
  });
  assert.notEqual(a.inputHash, changed.inputHash);
});

import { buildRiskLlmInput, enrichRiskReportWithLlm, type RiskLlmClient } from "./risk-report.js";

function baseReport(profileDoc = profile([cap("crud")])) {
  return buildRiskReport({ detectionId: "det_llm", profile: profileDoc, tests: [], targetMode: "demo" });
}

test("LLM enrichment merges new risks and keeps rule severity on duplicates", async () => {
  const base = baseReport();
  const duplicate = base.risks[0]!;
  const client: RiskLlmClient = {
    model: "fake-model",
    complete: async () => ({
      parsed: {
        risks: [
          { title: duplicate.title, category: duplicate.category, severity: "low", capabilityIds: ["crud"] },
          {
            title: "并发创建可能覆盖同一条记录",
            category: "concurrency",
            severity: "medium",
            confidence: 0.6,
            capabilityIds: ["crud"],
            testIdeas: ["两个 actor 同时创建"],
            missingInfo: ["需要唯一约束说明"],
          },
        ],
      },
      tokensUsed: 42,
    }),
  };
  const report = await enrichRiskReportWithLlm(base, profile([cap("crud")]), "demo", client);
  assert.equal(report.source, "rules+llm");
  assert.equal(report.model, "fake-model");
  assert.equal(report.tokensUsed, 42);
  const ruleItem = report.risks.find((item) => item.title === duplicate.title);
  assert.equal(ruleItem?.severity, "high");
  assert.equal(report.risks.filter((item) => item.title === duplicate.title).length, 1);
  assert.ok(report.risks.some((item) => item.category === "concurrency"));
});

test("invalid LLM output falls back to the rule report with an error", async () => {
  const base = baseReport();
  const client: RiskLlmClient = {
    model: "fake-model",
    complete: async () => ({ parsed: { nope: true }, tokensUsed: 1 }),
  };
  const report = await enrichRiskReportWithLlm(base, profile([cap("crud")]), "demo", client);
  assert.equal(report.source, "rules");
  assert.deepEqual(report.risks, base.risks);
  assert.match(report.llm?.error ?? "", /risks/);
});

test("LLM input excludes page text and marks ungrounded suggestions as assumptions", async () => {
  const profileWithEvidence = {
    ...profile([cap("crud")]),
    evidence: { pages: [{ route: "/", text: "PRIVATE-PAGE-TEXT", elements: [] }], frames: [], endpoints: [] },
  } as DetectionReport;
  const input = JSON.stringify(buildRiskLlmInput(profileWithEvidence, [], "real"));
  assert.equal(input.includes("PRIVATE-PAGE-TEXT"), false);

  const client: RiskLlmClient = {
    model: "fake-model",
    complete: async () => ({
      parsed: {
        risks: [
          { title: "未绑定能力的猜测", category: "coverage", severity: "low", confidence: 0.3 },
          { title: "真实环境的已知风险", category: "reliability", severity: "medium", evidenceRefs: ["ev-1"] },
        ],
      },
      tokensUsed: 2,
    }),
  };
  const report = await enrichRiskReportWithLlm(baseReport(), profileWithEvidence, "real", client);
  const guess = report.risks.find((item) => item.title === "未绑定能力的猜测");
  assert.equal(guess?.assumption, true);
  const other = report.risks.find((item) => item.title === "真实环境的已知风险");
  assert.deepEqual(other?.evidenceRefs, []);
});

test("LLM enrichment caps items and truncates long fields", async () => {
  const client: RiskLlmClient = {
    model: "fake-model",
    complete: async () => ({
      parsed: {
        risks: Array.from({ length: 30 }, (_, i) => ({
          title: `风险 ${i} ${"x".repeat(200)}`,
          category: "coverage",
          severity: "low",
          capabilityIds: ["crud"],
          testIdeas: Array.from({ length: 9 }, () => "y".repeat(400)),
        })),
      },
      tokensUsed: 3,
    }),
  };
  const report = await enrichRiskReportWithLlm(baseReport(), profile([cap("crud")]), "demo", client);
  const added = report.risks.filter((item) => item.title.startsWith("风险 "));
  assert.equal(added.length, 20);
  assert.ok(added.every((item) => item.title.length <= 120));
  assert.ok(added.every((item) => item.testIdeas.length <= 5));
  assert.ok(added.every((item) => item.testIdeas.every((idea) => idea.length <= 160)));
});

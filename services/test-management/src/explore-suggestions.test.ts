import assert from "node:assert/strict";
import test from "node:test";
import type { DetectionReport } from "@testpilot/detect";
import { buildExplorationSuggestions } from "./explore-suggestions.js";
import type { StoredTest } from "./store.js";

function profile(overrides: Partial<DetectionReport> = {}): DetectionReport {
  return {
    version: 1,
    target: { url: "http://127.0.0.1:4173", mode: "passive" },
    surfaces: [],
    signals: [],
    capabilities: [],
    questions: [],
    ...overrides,
  };
}

function approvedTest(id: string, ir: Partial<StoredTest["ir"]> & Pick<StoredTest["ir"], "steps" | "assertions">): StoredTest {
  return {
    id,
    projectId: "default",
    title: id,
    ir: { id, version: 1, platform: "web", baseUrl: "http://127.0.0.1:4173", ...ir },
    approvalStatus: "approved",
    updatedAt: new Date().toISOString(),
  };
}

test("suggests discovered-but-unvisited routes", () => {
  const suggestions = buildExplorationSuggestions(profile({ unvisited: [{ route: "/reports" }] }), []);
  const page = suggestions.find((item) => item.kind === "unvisited-page");
  assert.equal(page?.route, "/reports");
  assert.ok(page?.testIdeas.length);
});

test("suggests capabilities without approved coverage and respects coverage", () => {
  const cap = {
    id: "file-media" as const,
    confidence: 0.9,
    evidenceIds: ["ev-file"],
    signals: [],
    requires: [],
    unknowns: ["大小限制"],
  };
  const missing = buildExplorationSuggestions(profile({ capabilities: [cap] }), []);
  assert.ok(missing.some((item) => item.kind === "missing-scenario" && item.capabilityId === "file-media"));

  const covered = buildExplorationSuggestions(profile({ capabilities: [cap] }), [
    approvedTest("upload", {
      steps: [{ id: "up", action: "upload", target: { testId: "file" }, valueRef: "fixture.samplePng" }],
      assertions: [{ id: "ok", type: "ui", contains: "上传完成", oracle: "human-approved" }],
    }),
  ]);
  assert.equal(covered.some((item) => item.kind === "missing-scenario" && item.capabilityId === "file-media"), false);
});

test("turns open detection questions into exploration hints", () => {
  const suggestions = buildExplorationSuggestions(
    profile({
      questions: [
        {
          id: "q1",
          capability: "search-filter",
          question: "空态文案是什么？",
          evidenceIds: [],
          routes: ["/users"],
        },
      ],
    }),
    [],
  );
  const unknown = suggestions.find((item) => item.kind === "unknown");
  assert.match(unknown?.title ?? "", /空态文案/);
  assert.equal(unknown?.route, "/users");
});

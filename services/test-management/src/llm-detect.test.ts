import assert from "node:assert/strict";
import test from "node:test";
import type { SystemProfile } from "@testpilot/detect";
import { buildDetectionDigest, mergeLlmAnalysis, parseLlmDetection } from "./llm-detect.js";

const baseProfile: SystemProfile = {
  version: 1,
  target: { url: "https://real.example", mode: "passive" },
  surfaces: [],
  signals: [],
  capabilities: [],
  questions: [],
};

test("parseLlmDetection drops ungrounded capabilities and clamps confidence", () => {
  const parsed = parseLlmDetection({
    summary: "发现 Agent 平台",
    capabilities: [
      {
        id: "Agent MCP",
        label: "MCP",
        confidence: 1.4,
        evidence: ["/api/mexusclaw/mcp"],
        subCapabilities: ["连接"],
        testIdeas: ["验证 MCP 连接"],
        unknowns: [],
      },
      {
        id: "ungrounded",
        label: "没有证据",
        confidence: 0.9,
        evidence: [],
      },
    ],
    questions: ["是否允许启用 MCP？"],
  });
  assert.equal(parsed.capabilities.length, 1);
  assert.equal(parsed.capabilities[0]?.id, "agent-mcp");
  assert.equal(parsed.capabilities[0]?.confidence, 1);
  assert.deepEqual(parsed.questions, ["是否允许启用 MCP？"]);
});

test("buildDetectionDigest replaces the account name with a placeholder", () => {
  const digest = buildDetectionDigest({
    ...baseProfile,
    evidence: {
      pages: [
        {
          route: "/welcome",
          text: "赵哲 消息 小智",
          elements: [{ role: "div", name: "赵哲", testId: "user-menu-trigger" }],
        },
      ],
      frames: [{ route: "/mexusclaw/", text: "小智 工具 技能 MCP", elements: [] }],
      endpoints: [{ method: "GET", path: "/api/mexusclaw/tools", status: 200 }],
    },
  });
  assert.equal(digest.includes("赵哲"), false);
  assert.ok(digest.includes("[用户]"));
  assert.ok(digest.includes("mexusclaw"));
});

test("mergeLlmAnalysis keeps rule capabilities and adds LLM-only capabilities", () => {
  const profile: SystemProfile = {
    ...baseProfile,
    capabilities: [
      {
        id: "agent",
        confidence: 0.5,
        evidenceIds: ["ev-agent"],
        signals: ["dom.agent-chat"],
        requires: ["trace-source"],
        unknowns: [],
      },
    ],
  };
  const merged = mergeLlmAnalysis(profile, {
    used: true,
    summary: "发现小智",
    capabilities: [
      {
        id: "agent",
        label: "Agent",
        confidence: 0.9,
        evidence: ["/mexusclaw/"],
        subCapabilities: ["工具调用"],
        testIdeas: ["调用计算工具"],
        unknowns: [],
      },
      {
        id: "agent-mcp",
        label: "MCP",
        confidence: 0.8,
        evidence: ["/api/mexusclaw/mcp"],
        subCapabilities: ["工具市场"],
        testIdeas: ["验证 MCP 连接"],
        unknowns: [],
      },
    ],
    questions: ["是否允许启用 MCP？"],
    tokensUsed: 42,
    model: "test-model",
  });
  assert.equal(merged.capabilities[0]?.source, "hybrid");
  assert.equal(merged.capabilities[0]?.confidence, 0.9);
  assert.deepEqual(merged.capabilities[0]?.testIdeas, ["调用计算工具"]);
  assert.equal(merged.llmCapabilities?.[0]?.id, "agent-mcp");
  assert.deepEqual(merged.llmQuestions, ["是否允许启用 MCP？"]);
  assert.equal(merged.llmAnalysis?.tokensUsed, 42);
});

test("mergeLlmAnalysis records an unavailable LLM without inventing capabilities", () => {
  const merged = mergeLlmAnalysis(baseProfile, {
    used: false,
    summary: "",
    capabilities: [],
    questions: [],
    tokensUsed: 0,
    error: "LLM 未配置",
  });
  assert.equal(merged.llmCapabilities, undefined);
  assert.equal(merged.llmAnalysis?.used, false);
  assert.match(String(merged.llmAnalysis?.error ?? ""), /LLM 未配置/);
});

test("buildDetectionDigest stays valid JSON when evidence exceeds the budget", () => {
  const digest = buildDetectionDigest({
    ...baseProfile,
    capabilities: [],
    evidence: {
      pages: Array.from({ length: 12 }, (_, i) => ({
        route: `/p${i}`,
        text: "页面文本".repeat(600),
        elements: [],
      })),
      frames: Array.from({ length: 8 }, (_, i) => ({
        route: `/f${i}`,
        text: "iframe 工具目录".repeat(1_000),
        elements: [],
      })),
      endpoints: Array.from({ length: 300 }, (_, i) => ({
        method: "GET",
        path: `/api/item/${i}`,
      })),
    },
  });
  assert.ok(digest.length <= 28_000);
  const parsed = JSON.parse(digest) as { frames: unknown[]; pages: unknown[]; endpoints: unknown[] };
  assert.ok(parsed.frames.length >= 1);
  assert.ok(parsed.endpoints.length >= 20);
});

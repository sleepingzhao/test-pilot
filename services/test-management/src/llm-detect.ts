import { createHash } from "node:crypto";
import type {
  CapabilityAssessment,
  LlmAnalysisMeta,
  LlmCapabilityAssessment,
  SystemProfile,
} from "@testpilot/detect";
import { redactStringBody } from "@testpilot/evidence";
import { llmPlannerConfigFromEnv } from "./llm-config.js";
import { chatCompletionsJson } from "./llm-planner.js";
import { recordLlmFailure } from "./llm-usage.js";

export type LlmDetectionResult = {
  used: boolean;
  summary: string;
  capabilities: LlmCapabilityAssessment[];
  questions: string[];
  tokensUsed: number;
  model?: string;
  error?: string;
};

export type RawCapability = {
  id?: unknown;
  label?: unknown;
  confidence?: unknown;
  evidence?: unknown;
  subCapabilities?: unknown;
  testIdeas?: unknown;
  unknowns?: unknown;
};

export type RawDetection = {
  summary?: unknown;
  capabilities?: unknown;
  questions?: unknown;
};

const cache = new Map<string, LlmDetectionResult>();
const MAX_CACHE = 20;

// Detection reads more evidence than the planner and emits a larger JSON object,
// so it needs a longer wall clock than TESTPILOT_LLM_TIMEOUT_MS without inheriting
// an unbounded output budget from a context-size max_tokens setting.
const DETECT_TIMEOUT_MS = 180_000;
const DETECT_MAX_OUTPUT_TOKENS = 8_000;

/**
 * LLM is a first-class detector here: it reads bounded UI/API evidence and can
 * surface capabilities the fixed taxonomy did not anticipate (agent tools,
 * skills, MCP, memory, device controls). Rules still validate and persist.
 */
export async function analyzeCapabilitiesWithLlm(
  profile: SystemProfile,
): Promise<LlmDetectionResult> {
  const config = llmPlannerConfigFromEnv();
  if (!config) {
    return {
      used: false,
      summary: "",
      capabilities: [],
      questions: [],
      tokensUsed: 0,
      error: "LLM 未配置，已仅用规则结果",
    };
  }
  const digest = buildDetectionDigest(profile);
  const key = createHash("sha256").update(digest).digest("hex");
  const cached = cache.get(key);
  if (cached) return { ...cached, tokensUsed: 0 };

  const system = `你是 TestPilot 的能力分析师。阅读目标系统的 UI/API 证据，识别用户能做什么、可以怎么测。只返回一个 JSON 对象：
{"summary":string,"capabilities":[{"id":string,"label":string,"confidence":number,"evidence":string[],"subCapabilities":string[],"testIdeas":string[],"unknowns":string[]}],"questions":string[]}
规则：
- 现有分类 id：crud、auth、workflow、realtime-messaging、file-media、search-filter、agent、rich-content。发现新模式时用自定义 slug（例如 agent-tool-market、agent-mcp、agent-skills、agent-memory、device-control、knowledge-base）。
- Agent 平台是一等能力：工具市场、MCP、skills、记忆、模型路由、设备控制都要识别出子能力；testIdeas 要覆盖工具选择、工具参数、禁止工具、技能调用、检索落地、幻觉/拒答、记忆一致性、模型路由。
- 每个 capability 必须给出 evidence（route、页面可见标签、按钮/输入框、API 路径之一），没有证据就不要输出。
- 不要输出人名、邮箱、手机号、token、密钥或公司内部 ID；不要编造证据里没有的接口或功能。
- 最多 12 个 capability，每个最多 6 条 testIdeas；label/testIdeas/questions 用简洁中文。
- testIdeas 必须可执行，并写明需要什么证据（UI、API、工具调用、trace、DB）。`;

  try {
    const out = await chatCompletionsJson<RawDetection>(config, {
      system,
      user: `目标：${profile.target.url}\n证据：\n${digest}`,
      timeoutMs: Math.min(Math.max(config.timeoutMs, DETECT_TIMEOUT_MS), 300_000),
      maxOutputTokens: DETECT_MAX_OUTPUT_TOKENS,
    });
    const parsed = parseLlmDetection(out.parsed);
    const result: LlmDetectionResult = {
      used: true,
      ...parsed,
      tokensUsed: out.tokensUsed,
      model: config.model,
    };
    cache.set(key, result);
    if (cache.size > MAX_CACHE) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordLlmFailure(`能力分析失败：${message}`);
    return {
      used: false,
      summary: "",
      capabilities: [],
      questions: [],
      tokensUsed: 0,
      model: config.model,
      error: message,
    };
  }
}

/** Bounded, redacted digest. Page text is transient and never persisted. */
export function buildDetectionDigest(profile: SystemProfile): string {
  const accountNames = new Set<string>();
  for (const page of profile.evidence?.pages ?? []) {
    for (const element of page.elements) {
      if (/user-menu/i.test(element.testId ?? "") && element.name?.trim()) {
        accountNames.add(element.name.trim());
      }
    }
  }
  const scrub = (value: string): string => {
    let text = redactStringBody(value);
    for (const name of accountNames) text = text.split(name).join("[用户]");
    return text;
  };

  const pages = (profile.evidence?.pages ?? []).slice(0, 7).map((page) => ({
    route: page.route,
    title: page.title ? scrub(page.title) : undefined,
    text: scrub(page.text).slice(0, 1_200),
    controls: page.elements
      .filter((element) => !/user-menu/i.test(element.testId ?? ""))
      .slice(0, 40)
      .map((element) =>
        [element.role, element.name ? scrub(element.name) : undefined, element.testId]
          .filter(Boolean)
          .join(":"),
      )
      .join(" | "),
  }));
  const frames = (profile.evidence?.frames ?? []).slice(0, 6).map((frame) => ({
    route: frame.route,
    text: scrub(frame.text).slice(0, 4_000),
  }));
  const endpoints = (profile.evidence?.endpoints ?? [])
    .slice(0, 150)
    .map((endpoint) => `${endpoint.method} ${endpoint.path}${endpoint.status ? ` ${endpoint.status}` : ""}`);
  const ruleCapabilities = profile.capabilities.map((capability) => ({
    id: capability.id,
    confidence: Number(capability.confidence.toFixed(2)),
    signals: capability.signals,
    requires: capability.requires,
    unknowns: capability.unknowns,
  }));
  // Trim by whole sections so the digest is always valid JSON; frames carry the
  // embedded agent UI, so they are cut last.
  const body = {
    url: profile.target.url,
    pages,
    frames,
    endpoints,
    signals: profile.signals.map((signal) => signal.id),
    ruleCapabilities,
  };
  const budget = 28_000;
  let text = JSON.stringify(body, null, 2);
  while (text.length > budget && body.pages.length > 1) {
    body.pages.pop();
    text = JSON.stringify(body, null, 2);
  }
  while (text.length > budget && body.endpoints.length > 20) {
    body.endpoints = body.endpoints.slice(0, Math.ceil(body.endpoints.length / 2));
    text = JSON.stringify(body, null, 2);
  }
  while (text.length > budget && body.frames.length > 1) {
    body.frames.pop();
    text = JSON.stringify(body, null, 2);
  }
  return text;
}

export function parseLlmDetection(raw: RawDetection): {
  summary: string;
  capabilities: LlmCapabilityAssessment[];
  questions: string[];
} {
  const capabilities: LlmCapabilityAssessment[] = [];
  const sourceCapabilities = Array.isArray(raw.capabilities) ? raw.capabilities : [];
  for (const item of sourceCapabilities.slice(0, 12)) {
    if (!item || typeof item !== "object") continue;
    const capability = item as RawCapability;
    const id =
      typeof capability.id === "string"
        ? capability.id
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 60)
        : "";
    const label = typeof capability.label === "string" ? capability.label.trim().slice(0, 80) : "";
    if (!id || !label) continue;
    const evidence = stringList(capability.evidence, 8, 240);
    if (!evidence.length) continue;
    const confidence =
      typeof capability.confidence === "number" && Number.isFinite(capability.confidence)
        ? Math.min(1, Math.max(0, capability.confidence))
        : 0.6;
    capabilities.push({
      id,
      label,
      confidence,
      evidence,
      subCapabilities: stringList(capability.subCapabilities, 8, 160),
      testIdeas: stringList(capability.testIdeas, 6, 160),
      unknowns: stringList(capability.unknowns, 6, 160),
    });
  }
  return {
    summary: typeof raw.summary === "string" ? raw.summary.trim().slice(0, 600) : "",
    capabilities,
    questions: stringList(raw.questions, 10, 240),
  };
}

export function mergeLlmAnalysis(
  profile: SystemProfile,
  result: LlmDetectionResult,
): SystemProfile {
  const meta: LlmAnalysisMeta = {
    used: result.used,
    ...(result.model ? { model: result.model } : {}),
    ...(result.tokensUsed ? { tokensUsed: result.tokensUsed } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
  if (!result.used) return { ...profile, llmAnalysis: meta };

  const capabilities = profile.capabilities.map((capability) => ({ ...capability }));
  const existing = new Set(capabilities.map((capability) => capability.id));
  const llmCapabilities: LlmCapabilityAssessment[] = [];
  for (const capability of result.capabilities) {
    if (existing.has(capability.id as CapabilityAssessment["id"])) {
      const index = capabilities.findIndex((item) => item.id === capability.id);
      if (index >= 0) {
        capabilities[index] = {
          ...capabilities[index],
          confidence: Math.max(capabilities[index].confidence, capability.confidence),
          unknowns: [...new Set([...capabilities[index].unknowns, ...capability.unknowns])],
          testIdeas: [
            ...new Set([...(capabilities[index].testIdeas ?? []), ...capability.testIdeas]),
          ],
          source: "hybrid",
        };
      }
      continue;
    }
    llmCapabilities.push(capability);
  }
  return {
    ...profile,
    capabilities,
    llmCapabilities,
    llmSummary: result.summary,
    llmQuestions: result.questions,
    llmAnalysis: meta,
  };
}

function stringList(value: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, maxLength))
    .slice(0, limit);
}

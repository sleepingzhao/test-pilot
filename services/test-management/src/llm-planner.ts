import type { PageContext, PlannerDraft } from "@testpilot/planner";
import { mergeLlmHints, type LlmPlannerHints } from "@testpilot/planner";
import { planFromIntake } from "@testpilot/planner";
import { llmPlannerConfigFromEnv, type LlmPlannerConfig } from "./llm-config.js";
import { recordLlmFailure, recordLlmUsage } from "./llm-usage.js";

export { llmPlannerConfigFromEnv, llmPlannerPublicInfo, type LlmPlannerConfig, type LlmPlannerPublicInfo } from "./llm-config.js";

async function chatCompletionsJson<T>(
  config: LlmPlannerConfig,
  input: {
    system: string;
    user: string;
    timeoutMs?: number;
  },
): Promise<{ parsed: T; tokensUsed: number }> {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    }),
    signal: AbortSignal.timeout(input.timeoutMs ?? config.timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 240)}`);
  }

  const body = (await res.json()) as {
    usage?: { total_tokens?: number };
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = body.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as T;
  const tokensUsed = body.usage?.total_tokens ?? 0;
  recordLlmUsage(tokensUsed);
  return { parsed, tokensUsed };
}

export async function applyOptionalLlmDraft(input: {
  goal: string;
  context: PageContext;
  ruleDraft: ReturnType<typeof planFromIntake>;
}): Promise<{ draft: ReturnType<typeof planFromIntake>; llmTokensUsed: number; llmUsed: boolean }> {
  const config = llmPlannerConfigFromEnv();
  if (!config) {
    return { draft: input.ruleDraft, llmTokensUsed: 0, llmUsed: false };
  }
  try {
    const enhanced = await enhanceDraftWithLlm(config, {
      goal: input.goal,
      context: input.context,
      ruleDraft: input.ruleDraft,
    });
    return { draft: enhanced.draft, llmTokensUsed: enhanced.tokensUsed, llmUsed: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordLlmFailure(message);
    return {
      draft: {
        ...input.ruleDraft,
        uncertainties: [...input.ruleDraft.uncertainties, `LLM 不可用，已仅用规则引擎：${message}`],
      },
      llmTokensUsed: 0,
      llmUsed: false,
    };
  }
}

export async function enhanceDraftWithLlm(
  config: LlmPlannerConfig,
  input: { goal: string; context: PageContext; ruleDraft: PlannerDraft },
): Promise<{ draft: PlannerDraft; tokensUsed: number }> {
  const elementSample = input.context.elements
    .slice(0, 40)
    .map((el) => [el.role, el.name, el.testId].filter(Boolean).join(":"))
    .join("\n");

  const system = `You assist TestPilot QA planners. Reply with JSON only: {"uncertainties": string[], "assertionContains": string[]}.
Do not invent URLs. assertionContains must be short stable UI text visible after success. Never suggest assertions about file attachments.`;

  const user = `Goal: ${input.goal}
Page: ${input.context.url}
Interactive elements (sample):
${elementSample || "(none)"}
Existing rule steps: ${input.ruleDraft.steps.map((s) => s.id).join(", ") || "none"}
Existing uncertainties: ${input.ruleDraft.uncertainties.join(" | ")}`;

  let hints: LlmPlannerHints;
  let tokensUsed: number;
  try {
    const out = await chatCompletionsJson<LlmPlannerHints>(config, { system, user });
    hints = out.parsed;
    tokensUsed = out.tokensUsed;
  } catch (err) {
    if (err instanceof SyntaxError) {
      hints = { uncertainties: ["LLM 返回非 JSON，已忽略。"] };
      tokensUsed = 0;
      recordLlmFailure("LLM 返回非 JSON");
    } else {
      throw err;
    }
  }

  const draft = mergeLlmHints(input.ruleDraft, hints);
  return { draft, tokensUsed };
}

export async function suggestDiagnoseWithLlm(
  config: LlmPlannerConfig,
  input: {
    testTitle: string;
    failureKind: string | null;
    stepError?: string;
    assertionMessage?: string;
    ruleSuggestions: string[];
  },
): Promise<{ suggestions: string[]; tokensUsed: number }> {
  const system = `You help QA engineers fix flaky UI tests. Reply JSON only: {"suggestions": string[]}. Max 4 items, concise Chinese, no markdown. Do not mention uploading attachments.`;

  const user = `Test: ${input.testTitle}
Failure kind: ${input.failureKind ?? "UNKNOWN"}
Step error: ${input.stepError ?? "(none)"}
Assertion: ${input.assertionMessage ?? "(none)"}
Existing hints: ${input.ruleSuggestions.join(" | ")}`;

  let extra: string[] = [];
  let tokensUsed = 0;
  try {
    const out = await chatCompletionsJson<{ suggestions?: string[] }>(config, {
      system,
      user,
      timeoutMs: Math.min(config.timeoutMs, 30_000),
    });
    extra = (out.parsed.suggestions ?? []).map((s) => s.trim()).filter(Boolean);
    tokensUsed = out.tokensUsed;
  } catch {
    extra = [];
    recordLlmFailure("LLM 诊断调用失败");
  }

  const merged = [...input.ruleSuggestions];
  for (const s of extra) {
    if (!merged.includes(s)) merged.push(s);
  }
  return { suggestions: merged.slice(0, 8), tokensUsed };
}

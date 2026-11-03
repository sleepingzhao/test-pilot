import type { PageContext, PlannerDraft } from "@testpilot/planner";
import { mergeLlmHints, type LlmPlannerHints } from "@testpilot/planner";

export type LlmPlannerConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export function llmPlannerConfigFromEnv(): LlmPlannerConfig | null {
  const apiKey = process.env.TESTPILOT_LLM_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (process.env.TESTPILOT_LLM_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, ""),
    model: process.env.TESTPILOT_LLM_MODEL?.trim() || "gpt-4o-mini",
  };
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

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = (await res.json()) as {
    usage?: { total_tokens?: number };
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = body.choices?.[0]?.message?.content ?? "{}";
  let hints: LlmPlannerHints = {};
  try {
    hints = JSON.parse(raw) as LlmPlannerHints;
  } catch {
    hints = { uncertainties: ["LLM 返回非 JSON，已忽略。"] };
  }
  const draft = mergeLlmHints(input.ruleDraft, hints);
  return { draft, tokensUsed: body.usage?.total_tokens ?? 0 };
}

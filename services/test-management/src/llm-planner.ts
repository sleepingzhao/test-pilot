import type { PageContext, PlannerDraft } from "@testpilot/planner";
import { mergeLlmHints, validateLlmStepsAgainstContext, type LlmPlannerHints } from "@testpilot/planner";
import { planFromIntake } from "@testpilot/planner";
import { isWeakAssertionText } from "@testpilot/test-ir";
import { redactStringBody } from "@testpilot/evidence";
import { llmPlannerConfigFromEnv, type LlmPlannerConfig } from "./llm-config.js";
import { recordLlmFailure, recordLlmUsage } from "./llm-usage.js";

export { llmPlannerConfigFromEnv, llmPlannerPublicInfo, type LlmPlannerConfig, type LlmPlannerPublicInfo } from "./llm-config.js";

const learnedMaxTokens = new Map<string, number>();

function requestBody(config: LlmPlannerConfig, input: { system: string; user: string }, maxTokens: number) {
  return {
    model: config.model,
    temperature: config.temperature,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
  };
}

async function postChatCompletion(
  config: LlmPlannerConfig,
  input: { system: string; user: string },
  maxTokens: number,
  timeoutMs: number,
) {
  return fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody(config, input, maxTokens)),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** Providers reject max_tokens above their own output limit; learn it from the 400 body. */
function maxTokensLimitFromError(text: string): number | undefined {
  const match = /max_tokens[^[]*\[1,\s*(\d+)\]/i.exec(text);
  const limit = match ? Number(match[1]) : 0;
  return limit > 0 ? limit : undefined;
}

/** Providers occasionally wrap JSON in fences or emit a bad escape; recover what we can. */
function parseJsonObject<T>(raw: string): T {
  const text = raw.trim();
  const withoutFence = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(withoutFence) as T;
  } catch {
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(withoutFence.slice(start, end + 1)) as T;
    }
    throw new SyntaxError("LLM response is not a JSON object");
  }
}

async function chatCompletionsJson<T>(
  config: LlmPlannerConfig,
  input: {
    system: string;
    user: string;
    timeoutMs?: number;
  },
): Promise<{ parsed: T; tokensUsed: number }> {
  const timeoutMs = input.timeoutMs ?? config.timeoutMs;
  const cacheKey = `${config.baseUrl}|${config.model}`;
  const learned = learnedMaxTokens.get(cacheKey);
  let maxTokens = learned ? Math.min(config.maxTokens, learned) : config.maxTokens;

  let res = await postChatCompletion(config, input, maxTokens, timeoutMs);
  if (!res.ok && res.status === 400) {
    const text = await res.text();
    const limit = maxTokensLimitFromError(text);
    if (limit && limit < maxTokens) {
      learnedMaxTokens.set(cacheKey, limit);
      maxTokens = limit;
      res = await postChatCompletion(config, input, maxTokens, timeoutMs);
    } else {
      throw new Error(`LLM HTTP 400: ${text.slice(0, 240)}`);
    }
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 240)}`);
  }

  const readBody = async (response: Response) => {
    const body = (await response.json()) as {
      usage?: { total_tokens?: number };
      choices?: Array<{ message?: { content?: string } }>;
    };
    const tokens = body.usage?.total_tokens ?? 0;
    recordLlmUsage(tokens);
    return { raw: body.choices?.[0]?.message?.content ?? "{}", tokens };
  };

  const first = await readBody(res);
  let tokensUsed = first.tokens;
  try {
    return { parsed: parseJsonObject<T>(first.raw), tokensUsed };
  } catch {
    recordLlmFailure("LLM 返回非 JSON，已重试一次");
  }

  const retry = await postChatCompletion(
    config,
    {
      system: `${input.system}\nReturn ONLY one valid JSON object. No prose, no markdown fences, no trailing text.`,
      user: input.user,
    },
    maxTokens,
    timeoutMs,
  );
  if (!retry.ok) {
    const text = await retry.text();
    throw new Error(`LLM HTTP ${retry.status}: ${text.slice(0, 240)}`);
  }
  const second = await readBody(retry);
  tokensUsed += second.tokens;
  return { parsed: parseJsonObject<T>(second.raw), tokensUsed };
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

/**
 * A string already visible before the action cannot prove the action succeeded.
 * Drop those guesses (and generic chrome) before they become draft assertions.
 */
function filterHintAssertions(texts: string[] | undefined, context: PageContext): string[] {
  const pageText = context.elements.map((el) => el.name ?? "").join("\n");
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of texts ?? []) {
    const text = raw.trim();
    if (!text || seen.has(text)) continue;
    if (isWeakAssertionText(text)) continue;
    if (pageText.includes(text)) continue;
    seen.add(text);
    kept.push(text);
    if (kept.length >= 2) break;
  }
  return kept;
}

export async function enhanceDraftWithLlm(
  config: LlmPlannerConfig,
  input: { goal: string; context: PageContext; ruleDraft: PlannerDraft },
): Promise<{ draft: PlannerDraft; tokensUsed: number }> {
  const elementSample = input.context.elements
    .slice(0, 40)
    .map((el) => [el.role, el.name ? redactStringBody(el.name) : el.name, el.testId].filter(Boolean).join(":"))
    .join("\n");

  const system = `You assist TestPilot QA planners. Reply with JSON only: {"uncertainties": string[], "assertionContains": string[]}.
Do not invent URLs. assertionContains must be short stable UI text visible after success. Never suggest assertions about file attachments.`;

  const user = `Goal: ${redactStringBody(input.goal)}
Page: ${input.context.url}
Interactive elements (sample):
${elementSample || "(none)"}
Existing rule steps: ${input.ruleDraft.steps.map((s) => s.id).join(", ") || "none"}
Existing uncertainties: ${redactStringBody(input.ruleDraft.uncertainties.join(" | "))}`;

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

  const ruleAlreadyAssertsSuccess = input.ruleDraft.assertions.some((a) => a.id === "ticket-submitted");
  let draft = mergeLlmHints(input.ruleDraft, {
    ...hints,
    assertionContains: ruleAlreadyAssertsSuccess
      ? []
      : filterHintAssertions(hints.assertionContains, input.context),
  });
  tokensUsed += await tryAttachLlmSteps(config, input.goal, input.context, draft, (next) => {
    draft = next;
  });
  return { draft, tokensUsed };
}

async function tryAttachLlmSteps(
  config: LlmPlannerConfig,
  goal: string,
  context: PageContext,
  draft: PlannerDraft,
  apply: (next: PlannerDraft) => void,
): Promise<number> {
  if (context.form?.submitLabel) {
    // The dialog form was opened and its fields/options captured; replaying that
    // chain is more reliable than letting the LLM rewrite it from an element list.
    apply({
      ...draft,
      uncertainties: [
        ...draft.uncertainties,
        "表单字段与下拉选项取自打开表单时的实时快照，未采用 LLM 步骤覆盖。",
      ],
    });
    return 0;
  }
  const elementLines = context.elements
    .slice(0, 60)
    .map((el) =>
      [el.testId ? `testId=${el.testId}` : null, el.role, el.name ? redactStringBody(el.name) : el.name]
        .filter(Boolean)
        .join(" · "),
    )
    .join("\n");

  const system = `You are a QA automation planner. Reply JSON only:
{"steps":[{"id":string,"action":"navigate"|"click"|"fill"|"wait"|"select"|"selectCascader","path"?:string,"target"?:{"testId"?:string,"role"?:string,"name"?:string,"label"?:string},"value"?:string,"valueRef"?:string,"cascaderPath"?:string[]}],"uncertainties"?:string[]}
Rules: never invent testId or URLs; only use testId values listed above. Elements that appear after a click (dialogs, toasts) are not in the list — reference those with role+name or label. navigate.path must be relative (/...); selectors must match the element list; use valueRef env.* for secrets never literal passwords.`;

  const user = `Requirement:\n${redactStringBody(goal)}\nPage: ${context.url}\nElements:\n${elementLines || "(none)"}\nRule steps for reference: ${draft.steps.map((s) => s.id).join(", ")}`;

  try {
    const out = await chatCompletionsJson<{ steps?: unknown; uncertainties?: string[] }>(config, {
      system,
      user,
    });
    const validated = validateLlmStepsAgainstContext(
      out.parsed.steps as Parameters<typeof validateLlmStepsAgainstContext>[0],
      context,
    );
    if (validated.ok) {
      const ruleNavigate = draft.steps.find((s) => s.action === "navigate");
      const nextSteps =
        ruleNavigate && !validated.steps.some((s) => s.action === "navigate")
          ? [ruleNavigate, ...validated.steps]
          : validated.steps;
      // Rule template assertions describe the template's flow; when LLM steps take over,
      // keep only assertions whose text the requirement actually mentions.
      const nextAssertions = draft.assertions.filter((a) => {
        if (a.id?.startsWith("llm-hint-")) return true;
        const contains = (a as { contains?: string }).contains;
        return !contains || contains.length < 2 || goal.includes(contains.slice(0, 12));
      });
      apply({
        ...draft,
        steps: nextSteps,
        assertions: nextAssertions,
        uncertainties: [
          ...draft.uncertainties,
          ...(out.parsed.uncertainties ?? []),
          ...validated.warnings,
          "步骤由 LLM 根据快照生成，试跑后请核对。",
        ],
        sources: [...draft.sources, "llm-steps"],
      });
      return out.tokensUsed;
    }
    apply({
      ...draft,
      uncertainties: [
        ...draft.uncertainties,
        ...validated.issues,
        "LLM 步骤未通过快照校验，已回退规则草案——需人工补步骤。",
      ],
    });
    return out.tokensUsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordLlmFailure(message);
    apply({
      ...draft,
      uncertainties: [...draft.uncertainties, `LLM 步骤生成失败，已保留规则草案：${message}`],
    });
    return 0;
  }
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

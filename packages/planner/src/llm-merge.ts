import type { PlannerDraft } from "./types.js";

export type LlmPlannerHints = {
  uncertainties?: string[];
  assertionContains?: string[];
};

/** Merge LLM hints into a rule-based draft without replacing recorded steps. */
export function mergeLlmHints(ruleDraft: PlannerDraft, hints: LlmPlannerHints | null): PlannerDraft {
  if (!hints) return ruleDraft;
  const uncertainties = [...ruleDraft.uncertainties];
  for (const u of hints.uncertainties ?? []) {
    const line = u.trim();
    if (line && !uncertainties.includes(line)) uncertainties.push(line);
  }
  const assertions = [...ruleDraft.assertions];
  for (const text of hints.assertionContains ?? []) {
    const contains = text.trim();
    if (!contains) continue;
    if (assertions.some((a) => a.type === "ui" && "contains" in a && a.contains === contains)) continue;
    assertions.push({
      id: `llm-hint-${assertions.length + 1}`,
      type: "ui",
      contains,
      oracle: "human-approved",
    });
  }
  const sources = hints.uncertainties?.length || hints.assertionContains?.length
    ? [...ruleDraft.sources, "llm-hints"]
    : ruleDraft.sources;
  return { ...ruleDraft, uncertainties, assertions, sources };
}

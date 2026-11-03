import type { TestIR, TestAssertion } from "@testpilot/test-ir";
import { planFromIntake, suggestAssertionHints } from "./intake.js";
export type { PageContext, PlannerDraft, PlannerInput } from "./types.js";
import type { PlannerDraft, PlannerInput } from "./types.js";

export function planDraft(input: PlannerInput) {
  return planFromIntake({
    title: input.goal,
    channel: "intent",
    text: input.goal,
    context: input.context,
  });
}

export { planFromIntake, suggestAssertionHints, type IntakeChannel, type IntakeInput } from "./intake.js";
export { mergeLlmHints, type LlmPlannerHints } from "./llm-merge.js";

export function suggestAssertionsForTest(
  title: string,
  ir: Pick<TestIR, "steps">,
  intentSummary?: string,
): {
  assertions: TestAssertion[];
  uncertainties: string[];
  help: string;
  suggestions: string[];
} {
  const hints = suggestAssertionHints(title, ir.steps, intentSummary);
  const assertions: TestAssertion[] = [];
  const primary = hints.suggestions[0] ?? "成功";
  assertions.push({
    id: "suggest-primary",
    type: "ui",
    contains: primary,
    oracle: "human-approved",
  });
  return {
    assertions,
    uncertainties: hints.uncertainties,
    help: hints.help,
    suggestions: hints.suggestions,
  };
}

export function draftToPartialIR(
  id: string,
  draft: PlannerDraft,
): Pick<TestIR, "id" | "version" | "platform" | "steps" | "assertions"> {
  return {
    id,
    version: 1,
    platform: "web",
    steps: draft.steps,
    assertions: draft.assertions,
  };
}

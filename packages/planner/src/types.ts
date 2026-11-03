import type { TestAssertion, TestStep } from "@testpilot/test-ir";

export type PageContext = {
  url: string;
  elements: Array<{ role?: string; name?: string; testId?: string }>;
};

export type PlannerDraft = {
  steps: TestStep[];
  assertions: TestAssertion[];
  uncertainties: string[];
  sources: string[];
};

export type PlannerInput = {
  goal: string;
  context: PageContext;
};

import type { Locator, TestAssertion, TestStep } from "@testpilot/test-ir";

export function sameResultScope(a: Locator | undefined, b: Locator | undefined): boolean {
  return !!a && !!b && a.role === b.role && a.testId === b.testId &&
    (a.testId !== undefined || a.name === b.name);
}

/** Only the final search with a scoped, pre-query record check can support business coverage. */
export function searchProof(actions: TestStep[], assertion: TestAssertion) {
  const stage = (kind: "searchMatch" | "searchFilter", recordTexts: string[], input: Locator) => ({ kind, recordTexts, input });
  if (assertion.type !== "ui" || (assertion.provider && assertion.provider !== "playwright-ui") ||
      !assertion.searchResults || !assertion.notContains || !assertion.target?.role) return;
  const actor = assertion.actor ?? "primary";
  const steps = actions.filter(step => (step.actor ?? "primary") === actor);
  const [before, fill, submit] = steps.slice(-3);
  if (before?.action !== "wait" || before.recordTexts?.length !== 2 ||
      fill?.action !== "fill" || !fill.target || !fill.value?.trim() ||
      submit?.action !== "press" || submit.key !== "Enter" ||
      [before, fill, submit].some(step => step.frame !== assertion.frame) ||
      !sameResultScope(before.target, assertion.target) || !before.recordTexts.includes(assertion.notContains)) return;
  const [first, second] = before.recordTexts.map(text => text.trim().toLowerCase());
  if (!first || !second || first.includes(second) || second.includes(first)) return;
  if (assertion.searchResults === "match" && assertion.contains === fill.value &&
      assertion.contains !== assertion.notContains && before.recordTexts.includes(assertion.contains)) return stage("searchMatch", before.recordTexts, fill.target);
  const query = fill.value.trim().toLowerCase();
  if (assertion.searchResults === "empty" && !assertion.contains &&
      !first.includes(query) && !second.includes(query)) return stage("searchFilter", before.recordTexts, fill.target);
}

export function sameSearchInput(a: Locator, b: Locator): boolean {
  return a.testId === b.testId && a.role === b.role && a.name === b.name &&
    a.label === b.label && a.placeholder === b.placeholder && a.css === b.css;
}

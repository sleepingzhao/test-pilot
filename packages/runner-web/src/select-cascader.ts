import type { TestStep } from "@testpilot/test-ir";
import type { Page } from "playwright";

export async function executeSelectCascader(
  page: Page,
  step: TestStep,
  openTarget: () => Promise<void>,
): Promise<void> {
  const path = step.cascaderPath;
  if (!path?.length) throw new Error("selectCascader requires cascaderPath");
  await openTarget();
  for (const segment of path) {
    const item = page.getByRole("menuitem", { name: segment, exact: true }).last();
    await item.waitFor({ state: "visible", timeout: 10_000 });
    await item.click({ timeout: 10_000 });
  }
}

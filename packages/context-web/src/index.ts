import type { Page } from "playwright";
import type { PageContext } from "@testpilot/planner";

/**
 * Trimmed page snapshot for planner LLM calls (roadmap §5).
 * V0.1: role/name/testId only; no full DOM or screenshots.
 */
export async function snapshotPageContext(page: Page, scope?: string): Promise<PageContext> {
  const url = page.url();
  const elements = await page.evaluate((scopeSelector) => {
    const root = scopeSelector ? document.querySelector(scopeSelector) : document.body;
    if (!root) return [];
    const nodes = root.querySelectorAll(
      "button, a, input, select, textarea, [role], [data-testid]",
    );
    const out: Array<{ role?: string; name?: string; testId?: string; inputType?: string }> = [];
    nodes.forEach((el) => {
      if (out.length >= 40) return;
      const testId = el.getAttribute("data-testid") ?? undefined;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") ?? tag;
      const inputType = tag === "input" ? el.getAttribute("type") ?? "text" : undefined;
      const name =
        el.getAttribute("aria-label") ??
        (el as HTMLInputElement).labels?.[0]?.textContent?.trim() ??
        (el as HTMLElement).innerText?.trim().slice(0, 80) ??
        el.getAttribute("placeholder") ??
        undefined;
      out.push({ role, name, testId, inputType });
    });
    return out;
  }, scope ?? "");

  return { url, elements };
}

import type { Page } from "playwright";
import type { PageContext } from "@testpilot/planner";

/**
 * Trimmed page snapshot for planner LLM calls (roadmap §5).
 * Only visible elements are included: hidden dialogs on a dashboard otherwise
 * fill the list and push the form the user just opened past the cutoff.
 */
export async function snapshotPageContext(page: Page, scope?: string): Promise<PageContext> {
  const url = page.url();
  const elements = await page.evaluate((scopeSelector) => {
    const root = scopeSelector ? document.querySelector(scopeSelector) : document.body;
    if (!root) return [];
    const nodes = root.querySelectorAll(
      "button, a, input, select, textarea, [role], [data-testid]",
    );
    const isVisible = (el: Element) => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return false;
      }
      if (el.getAttribute("aria-hidden") === "true") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const out: Array<{ role?: string; name?: string; testId?: string; inputType?: string }> = [];
    nodes.forEach((el) => {
      if (out.length >= 160) return;
      if (!isVisible(el)) return;
      const testId = el.getAttribute("data-testid") ?? undefined;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") ?? tag;
      const inputType = tag === "input" ? el.getAttribute("type") ?? "text" : undefined;
      const name =
        el.getAttribute("aria-label") ??
        (el as HTMLInputElement).labels?.[0]?.textContent?.trim() ??
        el.getAttribute("placeholder") ??
        (el as HTMLElement).innerText?.trim().slice(0, 80) ??
        undefined;
      out.push({ role, name, testId, inputType });
    });
    return out;
  }, scope ?? "");

  return { url, elements };
}

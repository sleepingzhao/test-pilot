import type { Page } from "playwright";
import type { PageContext } from "@testpilot/planner";

/**
 * Trimmed page snapshot for planner LLM calls (roadmap §5).
 * Only visible elements are included: hidden dialogs on a dashboard otherwise
 * fill the list and push the form the user just opened past the cutoff.
 */
export async function snapshotPageContext(page: Page, scope?: string): Promise<PageContext> {
  const url = page.url();
  const snapshot = await page.evaluate((scopeSelector) => {
    const extractRepeatedBlockTexts = (scopeRoot: Element): string[] => {
      try {
        const skipContainer =
          /nav|menu|tab|breadcrumb|sidebar|pagination|toolbar|steps/i;
        const hasLetters = (text: string) => /[\p{L}\p{Script=Han}]/u.test(text);
        const parents: Element[] = [];
        const walkParents = (node: Element) => {
          parents.push(node);
          for (const child of Array.from(node.children)) {
            if (child instanceof Element) walkParents(child);
          }
        };
        walkParents(scopeRoot);

        let bestScore = -1;
        let bestTexts: string[] = [];
        let bestOrder = Number.POSITIVE_INFINITY;

        for (let pi = 0; pi < parents.length; pi++) {
          const parent = parents[pi]!;
          const elementChildren = Array.from(parent.children).filter(
            (child): child is Element => child instanceof Element,
          );
          if (elementChildren.length < 3) continue;

          const groups = new Map<string, Element[]>();
          for (const child of elementChildren) {
            const className = typeof child.className === "string" ? child.className.trim() : "";
            if (!className) continue;
            const cls = className.slice(0, 120);
            const key = `${child.tagName}|${cls}`;
            const bucket = groups.get(key);
            if (bucket) bucket.push(child);
            else groups.set(key, [child]);
          }

          for (const [groupKey, children] of groups) {
            if (children.length < 3) continue;
            const classPart = groupKey.split("|").slice(1).join("|");
            if (skipContainer.test(classPart)) continue;

            const inChrome = children.some((child) =>
              Boolean(
                child.closest(
                  'nav, header, [role="navigation"], [role="menu"], [role="tablist"]',
                ),
              ),
            );
            if (inChrome) continue;

            // Filter tabs / action rows repeat too; their children are controls, not list items.
            const interactive = children.filter((child) =>
              Boolean(
                child.closest(
                  'button, a, [role="button"], [role="tab"], [role="menuitem"], [role="option"], input, select, textarea',
                ),
              ),
            ).length;
            if (interactive * 2 >= children.length) continue;

            const usable: string[] = [];
            for (const child of children) {
              const rawText = (child as HTMLElement).innerText ?? "";
              // Use one real line, never the joined blob: "sender\nmessage" does not exist as one string,
              // so asserting or searching the blob fails even when the item is on screen.
              const line = rawText
                .split("\n")
                .map((part) => part.trim())
                .find((part) => part.length >= 4 && part.length <= 80);
              if (!line || !hasLetters(line)) continue;
              usable.push(line);
            }
            if (usable.length < 3) continue;

            const avgLen = usable.reduce((sum, t) => sum + t.length, 0) / usable.length;
            const score = usable.length * Math.min(avgLen, 40);
            if (score > bestScore || (score === bestScore && pi < bestOrder)) {
              bestScore = score;
              bestOrder = pi;
              const seen = new Set<string>();
              const picked: string[] = [];
              for (const text of usable) {
                const key = text.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                picked.push(text);
                if (picked.length >= 8) break;
              }
              bestTexts = picked;
            }
          }
        }
        return bestTexts;
      } catch {
        return [];
      }
    };

    const root = scopeSelector ? document.querySelector(scopeSelector) : document.body;
    if (!root) return { elements: [], texts: [] as string[] };
    const selector =
      "button, a, input, select, textarea, tr, td, th, li, table, ul, ol, h1, h2, h3, h4, [role], [data-testid]";
    const nodes: Element[] = [];
    const walk = (scopeRoot: Document | ShadowRoot) => {
      for (const el of Array.from(scopeRoot.querySelectorAll(selector))) nodes.push(el);
      for (const el of Array.from(scopeRoot.querySelectorAll("*"))) {
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root.ownerDocument ?? document);
    const isVisible = (el: Element) => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return false;
      }
      if (el.getAttribute("aria-hidden") === "true") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const out: Array<{
      role?: string;
      name?: string;
      testId?: string;
      inputType?: string;
      placeholder?: string;
      ariaLabel?: string;
      inNav?: boolean;
    }> = [];
    nodes.forEach((el: Element) => {
      if (out.length >= 240) return;
      if (!isVisible(el)) return;
      const testId = el.getAttribute("data-testid") ?? undefined;
      const tag = el.tagName.toLowerCase();
      const roleByTag: Record<string, string> = {
        h1: "heading",
        h2: "heading",
        h3: "heading",
        h4: "heading",
        h5: "heading",
        h6: "heading",
        table: "table",
        tr: "row",
        th: "columnheader",
        td: "cell",
        ul: "list",
        ol: "list",
        li: "listitem",
        a: "link",
        button: "button",
        input: "textbox",
        textarea: "textbox",
        select: "combobox",
      };
      const role = el.getAttribute("role") ?? roleByTag[tag] ?? tag;
      const inputType = tag === "input" ? el.getAttribute("type") ?? "text" : undefined;
      const ariaLabel = el.getAttribute("aria-label") ?? undefined;
      const placeholder = el.getAttribute("placeholder") ?? undefined;
      const inNav = Boolean(
        el.closest(
          'nav, header, aside, [role="navigation"], [role="menu"], [role="tablist"], [role="toolbar"]',
        ),
      );
      const name =
        ariaLabel ??
        (el as HTMLInputElement).labels?.[0]?.textContent?.trim() ??
        placeholder ??
        (el as HTMLElement).innerText?.trim().slice(0, 80) ??
        undefined;
      out.push({
        role,
        name,
        testId,
        inputType,
        ...(placeholder ? { placeholder } : {}),
        ...(ariaLabel ? { ariaLabel } : {}),
        ...(inNav ? { inNav } : {}),
      });
    });
    const texts = extractRepeatedBlockTexts(root);
    return { elements: out, texts };
  }, scope ?? "");

  return { url, elements: snapshot.elements, texts: snapshot.texts };
}

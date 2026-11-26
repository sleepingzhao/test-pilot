import type { Locator, Page } from "playwright";
import type { ListRecordScope } from "@testpilot/test-ir";

const roles = {
  table: 'table:not([role]), [role="table"]',
  grid: '[role="grid"]',
  list: 'ul:not([role]), ol:not([role]), [role="list"]',
} as const;
const containers = Object.values(roles).join(", ");

function probeRecordLists(elements: Element[], options: { roles: typeof roles; containers: string }) {
  const chrome = [
    "nav", "header", "aside", "footer", "script", "style", "template", '[role="navigation"]', '[role="menu"]', '[role="menuitem"]',
    '[role="tablist"]', '[role="toolbar"]', '[role="status"]', '[role="progressbar"]',
    '[aria-busy="true"]', "[hidden]", '[aria-hidden="true"]',
  ].join(", ");
  const rows = 'tr:not([role]), [role="row"]';
  const items = 'li:not([role]), [role="listitem"]';
  const cells = 'td:not([role]), [role="cell"], [role="gridcell"]';
  const headers = 'th:not([scope="row"]):not([role="rowheader"]), [role="columnheader"]';
  const placeholders = /^(?:暂无|无数据|没有数据|加载中|正在加载|请稍候|请稍后)|^(?:no (?:data|records?|results?|items?)(?: found| available)?|nothing here|loading(?: data| records| results)?)[.!…\s]*$/i;

  function visible(element: Element) {
    const { width, height } = element.getBoundingClientRect();
    return width > 0 && height > 0 && element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  }

  function recordText(record: Element, container: Element) {
    const walker = record.ownerDocument.createTreeWalker(record, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent && !parent.closest(chrome) && parent.closest(options.containers) === container &&
          parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
        parts.push(node.textContent ?? "");
      }
    }
    return parts.join("").trim().replace(/\s+/g, " ");
  }

  return elements.flatMap(container => {
    if (container.closest(chrome) || !visible(container)) return [];
    const role = (Object.keys(options.roles) as ListRecordScope["role"][]).find(key => container.matches(options.roles[key]));
    if (!role) return [];
    const isList = role === "list";
    const count = Array.from(container.querySelectorAll(isList ? items : rows)).filter(record => {
      if (record.closest(options.containers) !== container || record.closest(chrome) || !visible(record)) return false;
      if (!isList) {
        if (record.closest("thead, tfoot")) return false;
        const ownCells = Array.from(record.querySelectorAll(cells + ", " + headers))
          .filter(cell => cell.closest(rows) === record && visible(cell));
        if (ownCells.some(cell => cell.matches(headers)) || !ownCells.some(cell => cell.matches(cells))) return false;
      }
      const text = recordText(record, container);
      return text.length > 0 && !placeholders.test(text);
    }).length;
    return [{ role, testId: container.getAttribute("data-testid") || undefined, count }];
  });
}

/** Used at detection and at execution. Ambiguous locators cannot borrow records from another container. */
export async function countVisibleListRecords(locator: Locator, role: string): Promise<number> {
  const matches = await locator.evaluateAll(probeRecordLists, { roles, containers });
  return matches.length === 1 && matches[0]?.role === role ? matches[0].count : 0;
}

/** Keep a scoped locator only when one list is demonstrably usable in the snapshot. */
export async function observeRecordList(page: Page): Promise<ListRecordScope | undefined> {
  const matches = await page.locator(containers).evaluateAll(probeRecordLists, { roles, containers });
  const populated = matches.filter(item => item.count >= 2);
  if (populated.length !== 1) return;
  const candidate = populated[0]!;
  if (candidate.testId && await page.getByTestId(candidate.testId).count() === 1) {
    return { role: candidate.role, testId: candidate.testId };
  }
  if (await page.getByRole(candidate.role).count() === 1) return { role: candidate.role };
}

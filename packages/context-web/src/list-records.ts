import type { Locator, Page } from "playwright";
import type { ListRecordScope } from "@testpilot/test-ir";

const roles = {
  table: 'table:not([role]), [role="table"]',
  grid: '[role="grid"]',
  list: 'ul:not([role]), ol:not([role]), [role="list"]',
} as const;
const containers = Object.values(roles).join(", ");

function probeRecordLists(elements: Element[], options: { roles: typeof roles; containers: string; terms?: string[] }) {
  const chrome = [
    "nav", "header", "aside", "footer", "script", "style", "template", '[role="navigation"]', '[role="menu"]', '[role="menuitem"]',
    '[role="tablist"]', '[role="toolbar"]', '[role="status"]', '[role="progressbar"]',
    '[aria-busy="true"]', "[hidden]", '[aria-hidden="true"]',
  ].join(", ");
  const rows = 'tr:not([role]), [role="row"]';
  const items = 'li:not([role]), [role="listitem"]';
  const cells = 'td:not([role]), [role="cell"], [role="gridcell"]';
  const headers = 'th:not([scope="row"]):not([role="rowheader"]), [role="columnheader"]';
  const loading = /^(?:加载中|正在加载|请稍候|请稍后)|^loading(?: data| records| results)?[.!…\s]*$/i;
  const empty = /^(?:暂无|无数据|没有数据)|^(?:no (?:data|records?|results?|items?)(?: found| available)?|nothing here)[.!…\s]*$/i;

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
    const terms = options.terms ?? [];
    const matchedRows = terms.map(() => [] as number[]);
    let pending = terms.length > 0 && Array.from(
      container.querySelectorAll('[aria-busy="true"], [role="progressbar"], [role="status"]'),
    ).some(element => element.closest(options.containers) === container && visible(element) &&
      (element.getAttribute("role") !== "status" || element.getAttribute("aria-busy") === "true" ||
        loading.test((element as HTMLElement).innerText?.trim() ?? "")));
    const count = Array.from(container.querySelectorAll(isList ? items : rows)).filter((record, rowIndex) => {
      if (record.closest(options.containers) !== container || !visible(record)) return false;
      if (loading.test((record as HTMLElement).innerText?.trim() ?? "")) pending = true;
      if (record.closest(chrome)) return false;
      if (!isList) {
        if (record.closest("thead, tfoot")) return false;
        const ownCells = Array.from(record.querySelectorAll(cells + ", " + headers))
          .filter(cell => cell.closest(rows) === record && visible(cell));
        if (ownCells.some(cell => cell.matches(headers)) || !ownCells.some(cell => cell.matches(cells))) return false;
      }
      const text = recordText(record, container);
      if (!text || empty.test(text) || loading.test(text)) return false;
      terms.forEach((term, index) => { if (text.includes(term)) matchedRows[index]!.push(rowIndex); });
      return true;
    }).length;
    const present = matchedRows.map(rows => rows.length > 0);
    const distinct = present.every(Boolean) && (terms.length < 2 ||
      matchedRows.some(rows => rows.length > 1) || matchedRows[0]![0] !== matchedRows[1]![0]);
    return [{ role, testId: container.getAttribute("data-testid") || undefined, count, pending, present, distinct }];
  });
}

/** Return predicates and count without exporting actual record text from the browser. */
export async function readVisibleListRecords(locator: Locator, role: string, terms: string[] = []) {
  const matches = await locator.evaluateAll(probeRecordLists, { roles, containers, terms });
  const [result] = matches;
  return matches.length === 1 && result?.role === role ? result : undefined;
}

export async function countVisibleListRecords(locator: Locator, role: string): Promise<number> {
  return (await readVisibleListRecords(locator, role))?.count ?? 0;
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

import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Page } from "playwright";
import { observeRecordList } from "@testpilot/context-web";
import type { TestAssertion } from "@testpilot/test-ir";
import { runUiAssertion, waitForVisibleRecordTexts } from "./index.js";
import type { AssertionContext } from "./types.js";

function fakePage(count: number): Page {
  return {
    getByRole: () => ({ count: async () => count }),
  } as unknown as Page;
}

const ctx = (count: number) =>
  ({ page: fakePage(count), network: [], resolveRequestRef: () => undefined }) as unknown as AssertionContext;

process.env.TESTPILOT_UI_ASSERT_TIMEOUT_MS = "0";

test("minCount passes when enough elements match", async () => {
  const outcome = await runUiAssertion(
    { id: "rows", type: "ui", target: { role: "row" }, minCount: 2, oracle: "human-approved" },
    ctx(3),
  );
  assert.equal(outcome.passed, true);
  assert.equal(outcome.actual, "3");
});

test("minCount fails when too few elements match", async () => {
  const outcome = await runUiAssertion(
    { id: "rows", type: "ui", target: { role: "row" }, minCount: 2, oracle: "human-approved" },
    ctx(1),
  );
  assert.equal(outcome.passed, false);
  assert.equal(outcome.errorKind, "PRODUCT_DEFECT");
  assert.equal(outcome.actual, "1");
  assert.match(outcome.message ?? "", /at least 2 elements/);
});

test("minCount fails when no element matches", async () => {
  const outcome = await runUiAssertion(
    { id: "rows", type: "ui", target: { role: "row" }, minCount: 2, oracle: "human-approved" },
    ctx(0),
  );
  assert.equal(outcome.passed, false);
  assert.equal(outcome.errorKind, "PRODUCT_DEFECT");
});


test("listRecords counts only visible records in its own table or list", async (t) => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const table = (content: string) => `<table data-testid="records"><thead><tr><th>Name</th></tr></thead><tbody>${content}</tbody></table>`;
    const cases = [
      { name: "two visible table records", html: table("<tr><td>Alpha</td></tr><tr><td>Beta</td></tr>"), count: 2 },
      { name: "header and empty state", html: table("<tr><td>暂无数据</td></tr>"), count: 0 },
      { name: "header and loading placeholder", html: table("<tr><td>Loading records…</td></tr>"), count: 0 },
      { name: "status content cannot act as a record", html: table('<tr><td><span role="status">Fetching entries</span></td></tr>'), count: 0 },
      { name: "a visible row shell with only hidden content is empty", html: table('<tr><td style="height:20px"><span style="visibility:hidden">Hidden</span></td></tr>'), count: 0 },
      { name: "one record with several cells", html: table("<tr><td>A</td><td>B</td><td>C</td></tr>"), count: 1 },
      { name: "hidden records", html: table("<tr hidden><td>A</td></tr><tr style='visibility:hidden'><td>B</td></tr>"), count: 0 },
      {
        name: "nested and adjacent tables cannot add records to the selected table",
        html: table("<tr><td>Outer<table><tr><td>Nested</td></tr></table></td></tr>") +
          "<table><tr><td>Other A</td></tr><tr><td>Other B</td></tr></table>",
        count: 1,
      },
      {
        name: "visible list with navigation ignored",
        html: '<nav><ul><li>Home</li><li>Tasks</li></ul></nav><ul data-testid="records"><li>Alpha</li><li>Beta</li></ul>',
        count: 2, role: "list",
      },
      {
        name: "navigation cannot qualify as a business list",
        html: '<nav><ul data-testid="records"><li>Home</li><li>Tasks</li></ul></nav>',
        count: 0, role: "list",
      },
      {
        name: "two lists with the same test ID cannot supply a stable scope",
        html: table("<tr><td>Alpha</td></tr><tr><td>Beta</td></tr>").repeat(2),
        count: 0,
      },
      {
        name: "visible ARIA grid rows count as records",
        html: '<div role="grid" data-testid="records"><div role="row"><span role="columnheader">Name</span></div>' +
          '<div role="row"><span role="gridcell">Alpha</span></div><div role="row"><span role="gridcell">Beta</span></div></div>',
        count: 2, role: "grid",
      },
    ] as const;

    for (const fixture of cases) {
      await t.test(fixture.name, async () => {
        await page.setContent(fixture.html);
        const target = { role: "role" in fixture ? fixture.role : "table", testId: "records" } as const;
        const assertion: TestAssertion = { type: "ui", listRecords: true, minCount: 2, target, oracle: "human-approved" };
        const outcome = await runUiAssertion(assertion, { ...ctx(0), page });
        assert.equal(outcome.actual, String(fixture.count), outcome.message);
        assert.equal(outcome.passed, fixture.count >= 2);
        if (fixture.count < 2) assert.equal(outcome.errorKind, "PRODUCT_DEFECT");
        // The unrelated table has data, but has no unique role or test ID.
        const expected = fixture.count >= 2 ? target : undefined;
        assert.deepEqual(await observeRecordList(page), expected);
      });
    }
  } finally {
    await browser.close();
  }
});

test("search only accepts visible business records in the selected result container", async (t) => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const target = { role: "table", testId: "results" };
    const table = (body: string, attrs = "", header = "Member") =>
      `<table data-testid="results"${attrs}><thead><tr><th>${header}</th></tr></thead><tbody>${body}</tbody></table>`;
    const alpha = "<tr><td>Alpha</td></tr>";
    const beta = "<tr><td>Beta</td></tr>";
    const cases = [
      { name: "matching record with comparison removed", mode: "match", html: table(alpha), passed: true },
      { name: "comparison record remains", mode: "match", html: table(alpha + beta), passed: false },
      { name: "header text cannot supply a match", mode: "match", html: table("", "", "Alpha"), passed: false },
      { name: "hidden record cannot supply a match", mode: "match", html: table("<tr hidden><td>Alpha</td></tr>"), passed: false },
      { name: "adjacent table cannot supply a match", mode: "match", html: table(beta) + `<table>${alpha}</table>`, passed: false },
      { name: "empty results with an adjacent populated table", mode: "empty", html: table("") + `<table>${alpha}</table>`, passed: true },
      { name: "empty-state placeholder", mode: "empty", html: table("<tr><td>暂无数据</td></tr>"), passed: true },
      { name: "loading placeholder", mode: "empty", html: table("<tr><td>Loading records…</td></tr>"), passed: false },
      { name: "unrelated record remains", mode: "empty", html: table(beta), passed: false },
      { name: "result container is busy", mode: "empty", html: table("", ' aria-busy="true"'), passed: false },
      { name: "result body is busy", mode: "empty", html: table(beta).replace("<tbody>", '<tbody aria-busy="true">'), passed: false },
      { name: "result container is hidden", mode: "empty", html: table("", " hidden"), passed: false },
      { name: "result container is missing", mode: "empty", html: "<p>Search finished</p>", passed: false },
      { name: "duplicate result containers", mode: "empty", html: table("") + table(""), passed: false },
    ] as const;
    for (const { name, mode, html, passed } of cases) {
      await t.test(name, async () => {
        await page.setContent(html);
        const assertion: TestAssertion = {
          type: "ui", oracle: "human-approved", target, searchResults: mode,
          ...(mode === "match" ? { contains: "Alpha", notContains: "Beta" } : { notContains: "Alpha" }),
        };
        const outcome = await runUiAssertion(assertion, { ...ctx(0), page });
        assert.equal(outcome.passed, passed, outcome.message);
        if (!passed) assert.equal(outcome.errorKind, "PRODUCT_DEFECT");
      });
    }
    await page.setContent(table(alpha + beta));
    assert.equal(await waitForVisibleRecordTexts(page, target, ["Alpha", "Beta"]), true);
    await page.setContent(table("<tr><td>Alpha and Beta</td></tr>"));
    assert.equal(await waitForVisibleRecordTexts(page, target, ["Alpha", "Beta"]), false);
  } finally {
    await browser.close();
  }
});

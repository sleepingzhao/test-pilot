import assert from "node:assert/strict";
import test from "node:test";
import type { DetectionReport } from "@testpilot/detect";
import { businessCoverage } from "./route-coverage.js";
import { itemTexts, planReadOnlyCases } from "./read-only-suite.js";
import type { StoredTest } from "./store.js";

function profile(): DetectionReport {
  return {
    version: 1,
    target: { url: "https://real.example.com", mode: "passive" },
    signals: [],
    questions: [],
    capabilities: [],
    frameSurfaces: [
      {
        route: "/gallery/",
        elements: [
          { role: "heading", name: "团队相册" },
          { role: "input", name: "搜索相册", inputType: "text", placeholder: "搜索相册" },
        ],
      },
      {
        route: "/inbox/",
        elements: [{ role: "heading", name: "聊天记录" }],
      },
    ],
    surfaces: [
      {
        route: "/people/",
        elements: [
          { role: "button", name: "赵哲", testId: "user-menu-trigger" },
          { role: "tab", name: "全部" },
          { role: "heading", name: "联系人列表" },
          { role: "input", name: "搜索", inputType: "text", placeholder: "搜索" },
        ],
      },
      {
        route: "/covered/",
        elements: [{ role: "button", name: "赵哲", testId: "user-menu-trigger" }, { role: "heading", name: "已覆盖页面" }],
      },
      {
        route: "/bare/",
        elements: [{ role: "div", name: "保存" }],
      },
    ],
  };
}

function approvedReal(path: string): StoredTest {
  return {
    id: "approved",
    projectId: "default",
    title: "approved",
    ir: {
      id: "approved",
      version: 1,
      platform: "web",
      baseUrlRef: "real-env",
      steps: [{ id: "open", action: "navigate", path }],
      assertions: [{ id: "ok", type: "ui", urlIncludes: path, oracle: "human-approved" }],
    },
    approvalStatus: "approved",
    updatedAt: new Date().toISOString(),
  };
}

test("plans load and search cases only for uncovered real routes", () => {
  const cases = planReadOnlyCases({
    detectionId: "detect_x",
    profile: profile(),
    tests: [approvedReal("/covered/"), approvedReal("/inbox/")],
    targetMode: "real",
  });
  assert.deepEqual(cases.map((item) => `${item.route}:${item.kind}`).sort(), [
    "/bare:load",
    "/gallery:load",
    "/gallery:search",
    "/people:load",
    "/people:search",
  ]);
  for (const item of cases) {
    assert.equal(item.ir.baseUrlRef, "real-env");
    assert.equal(item.ir.policy?.allowMutation, undefined);
    assert.ok(item.ir.assertions.length > 0);
    assert.ok(item.ir.assertions[0]?.urlIncludes?.startsWith(item.route));
    assert.equal(
      item.ir.assertions.some((assertion) => assertion.target?.testId === "user-menu-trigger"),
      false,
    );
    assert.match(item.testId, /^[a-z0-9][a-z0-9-]*$/);
  }
  const search = cases.find((item) => item.route === "/people" && item.kind === "search")!;
  assert.deepEqual(search.ir.steps[2]?.target, { placeholder: "搜索" });
  const content = cases.find((item) => item.route === "/gallery" && item.kind === "load")!;
  assert.match(content.testId, /-content-/);
  assert.match(content.title, /内容页/);
  assert.equal(cases.some((item) => item.route === "/inbox"), false);
});

test("a load-only approved case still lets the search scenario generate", () => {
  const cases = planReadOnlyCases({
    detectionId: "detect_x",
    profile: profile(),
    tests: [approvedReal("/people/")],
    targetMode: "real",
  });
  assert.equal(cases.some((item) => item.route === "/people" && item.kind === "load"), false);
  assert.equal(cases.some((item) => item.route === "/people" && item.kind === "search"), true);
});

test("does not generate for non-real targets and respects the limit", () => {
  assert.equal(planReadOnlyCases({ detectionId: "d", profile: profile(), tests: [], targetMode: "demo" }).length, 0);
  const limited = planReadOnlyCases({
    detectionId: "d",
    profile: profile(),
    tests: [],
    targetMode: "real",
    limit: 1,
  });
  assert.equal(limited.length, 1);
});

function listSurfaceProfile(): DetectionReport {
  return {
    version: 1,
    target: { url: "https://real.example.com", mode: "passive" },
    signals: [],
    questions: [],
    capabilities: [],
    surfaces: [
      {
        route: "/members/",
        recordList: { role: "table", testId: "members" },
        elements: [
          { role: "row", name: "Alice Chen" },
          { role: "row", name: "Bob Wang" },
          { role: "row", name: "Carol Liu" },
          { role: "columnheader", name: "成员姓名" },
          { role: "input", name: "搜索成员", inputType: "text", placeholder: "搜索成员" },
        ],
      },
    ],
  };
}

test("semantic list surface generates minCount load and paired search cases", () => {
  const profile = listSurfaceProfile();
  const firstItem = itemTexts(profile.surfaces[0]!, new Set())[0]!;
  const cases = planReadOnlyCases({
    detectionId: "detect_list",
    profile,
    tests: [],
    targetMode: "real",
  });
  const load = cases.find((item) => item.kind === "load" && item.route === "/members")!;
  assert.ok(load);
  assert.ok(
    load.ir.assertions.some(
      (assertion) => assertion.target?.testId === "members" && assertion.listRecords && assertion.minCount === 2,
    ),
  );
  const match = cases.find((item) => item.testId.endsWith("-search-match"))!;
  assert.equal(match.ir.assertions.find((a) => a.id === "match")?.contains, firstItem);
  assert.ok(match.ir.steps.some((step) => step.action === "press" && step.key === "Enter"));
  const none = cases.find((item) => item.testId.endsWith("-search-none"))!;
  const filtered = none.ir.assertions.find((a) => a.id === "filtered")!;
  assert.deepEqual(filtered.target, { role: "table", testId: "members" });
  assert.equal(filtered.searchResults, "empty");
  assert.equal(none.ir.steps.find(step => step.id === "baseline-records")?.recordTexts?.length, 2);
  assert.equal(filtered.notContains, firstItem);
});

test("search smoke remains when only global chrome and search box exist", () => {
  const cases = planReadOnlyCases({
    detectionId: "d",
    profile: {
      version: 1,
      target: { url: "https://real.example.com", mode: "passive" },
      signals: [],
      questions: [],
      capabilities: [],
      surfaces: [
        {
          route: "/shell/",
          elements: [
            { role: "button", name: "赵哲", testId: "user-menu-trigger" },
            { role: "input", name: "搜索", placeholder: "搜索" },
          ],
        },
        {
          route: "/shell/",
          elements: [{ role: "button", name: "赵哲", testId: "user-menu-trigger" }],
        },
      ],
    },
    tests: [],
    targetMode: "real",
  });
  assert.equal(cases.some((item) => item.testId.endsWith("-search-match")), false);
  assert.equal(cases.some((item) => item.testId.endsWith("-search-none")), false);
  assert.ok(cases.some((item) => item.testId.endsWith("-search")));
});

test("detail case asserts item visible and list header gone", () => {
  const cases = planReadOnlyCases({
    detectionId: "d",
    profile: {
      version: 1,
      target: { url: "https://real.example.com", mode: "passive" },
      signals: [],
      questions: [],
      capabilities: [],
      surfaces: [
        {
          route: "/items/",
          elements: [
            { role: "columnheader", name: "项目名称" },
            { role: "row", name: "Project Atlas" },
            { role: "row", name: "Project Beacon" },
            { role: "link", name: "Project Atlas" },
          ],
        },
      ],
    },
    tests: [],
    targetMode: "real",
  });
  const detail = cases.find((item) => item.kind === "detail")!;
  assert.ok(detail);
  const assertion = detail.ir.assertions[0]!;
  assert.equal(assertion.contains, "Project Atlas");
  assert.equal(assertion.notContains, "项目名称");
});

test("an approved assertion of the selected item and disappearance of its list header covers detail", () => {
  const cases = planReadOnlyCases({
    detectionId: "d",
    profile: {
      version: 1,
      target: { url: "https://real.example.com", mode: "passive" },
      signals: [],
      questions: [],
      capabilities: [],
      surfaces: [
        {
          route: "/items/",
          elements: [
            { role: "columnheader", name: "项目名称" },
            { role: "row", name: "Project Atlas" },
            { role: "row", name: "Project Beacon" },
            { role: "link", name: "Project Atlas" },
          ],
        },
      ],
    },
    tests: [
      {
        id: "covered-detail",
        projectId: "default",
        title: "covered",
        approvalStatus: "approved",
        updatedAt: new Date().toISOString(),
        ir: {
          id: "covered-detail",
          version: 1,
          platform: "web",
          baseUrlRef: "real-env",
          steps: [
            { id: "open", action: "navigate", path: "/items/" },
            { id: "go", action: "click", target: { role: "link", name: "Project Atlas" } },
          ],
          assertions: [{ id: "ok", type: "ui", contains: "Project Atlas", notContains: "项目名称", oracle: "human-approved" }],
        },
      },
    ],
    targetMode: "real",
  });
  assert.equal(cases.some((item) => item.kind === "detail"), false);
});

test("contentTexts without a reliable result container generates search smoke only", () => {
  const cases = planReadOnlyCases({
    detectionId: "d",
    profile: {
      version: 1,
      target: { url: "https://real.example.com", mode: "passive" },
      signals: [],
      questions: [],
      capabilities: [],
      surfaces: [
        {
          route: "/cards/",
          elements: [
            { role: "heading", name: "项目列表" },
            { role: "input", name: "搜索", inputType: "text", placeholder: "搜索" },
            { role: "div", name: "保存" },
          ],
        },
      ],
    },
    tests: [],
    targetMode: "real",
    contentTexts: {
      "/cards/": ["Alpha Centauri", "Beta Hydrae", "Gamma Orion"],
    },
  });
  assert.ok(cases.some(item => item.testId.endsWith("-search")));
  assert.ok(cases.every(item => item.ir.assertions.every(a => !a.searchResults && !a.minCount)));
});

test("fallback texts skip labels that are page chrome", () => {  const cases = planReadOnlyCases({
    detectionId: "d",
    profile: {
      version: 1,
      target: { url: "https://real.example.com", mode: "passive" },
      signals: [],
      questions: [],
      capabilities: [],
      surfaces: [
        {
          route: "/tasks/",
          recordList: { role: "list", testId: "tasks" },
          elements: [
            { role: "button", name: "全部任务" },
            { role: "input", name: "搜索", inputType: "text", placeholder: "搜索" },
          ],
        },
      ],
    },
    tests: [],
    targetMode: "real",
    contentTexts: {
      "/tasks/": ["全部任务", "Prepare quarterly report", "Review budget"],
    },
  });
  const match = cases.find((item) => item.testId.endsWith("-search-match"));
  assert.ok(match);
  assert.equal(
    match!.ir.assertions.some((a) => a.contains === "Prepare quarterly report"),
    true,
  );
  assert.equal(match!.ir.assertions.some((a) => a.contains === "全部任务"), false);
});

test("list-item tabs are not used as search item text", () => {
  const cases = planReadOnlyCases({
    detectionId: "d",
    profile: {
      version: 1,
      target: { url: "https://real.example.com", mode: "passive" },
      signals: [],
      questions: [],
      capabilities: [],
      surfaces: [
        {
          route: "/tasks/",
          recordList: { role: "list", testId: "tasks" },
          elements: [
            { role: "listitem", name: "全部任务 0" },
            { role: "listitem", name: "Prepare quarterly report" },
            { role: "listitem", name: "Review budget" },
            { role: "input", name: "搜索", inputType: "text", placeholder: "搜索" },
          ],
        },
      ],
    },
    tests: [],
    targetMode: "real",
  });
  assert.equal(cases.some((item) => JSON.stringify(item.ir).includes("全部任务")), false);
  const match = cases.find((item) => item.testId.endsWith("-search-match"));
  assert.ok(match);
});

test("nav links and empty-state rows do not produce semantic search or detail cases", () => {
  const cases = planReadOnlyCases({
    detectionId: "d",
    profile: {
      version: 1,
      target: { url: "https://real.example.com", mode: "passive" },
      signals: [],
      questions: [],
      capabilities: [],
      surfaces: [
        {
          route: "/sop/",
          elements: [
            { role: "link", name: "执行记录", inNav: true },
            { role: "link", name: "回收站", inNav: true },
            { role: "row", name: "图标\t流程名\t创建人" },
            { role: "row", name: "暂无数据" },
            { role: "cell", name: "暂无数据" },
            { role: "cell", name: "加载中…" },
            { role: "columnheader", name: "流程名" },
            { role: "input", name: "搜索", inputType: "text", placeholder: "搜索" },
          ],
        },
      ],
    },
    tests: [],
    targetMode: "real",
  });
  assert.equal(cases.some((item) => item.testId.endsWith("-search-match")), false);
  assert.equal(cases.some((item) => item.testId.endsWith("-search-none")), false);
  assert.equal(cases.some((item) => item.kind === "detail"), false);
  const load = cases.find((item) => item.kind === "load");
  assert.ok(load);
  assert.equal(load!.ir.assertions.some((a) => typeof a.minCount === "number"), false);
});

test("the filtering case is trialled before the hit case", () => {
  const cases = planReadOnlyCases({
    detectionId: "detect_list",
    profile: listSurfaceProfile(),
    tests: [],
    targetMode: "real",
  });
  const ids = cases.map((item) => item.testId);
  const none = ids.findIndex((id) => id.endsWith("-search-none"));
  const match = ids.findIndex((id) => id.endsWith("-search-match"));
  assert.ok(none >= 0 && match >= 0);
  assert.ok(none < match);
});

test("an approved URL smoke can gain a distinct list case in the same detection", () => {
  const profile = listSurfaceProfile();
  const smoke = approvedReal("/members/");
  smoke.id = smoke.ir.id = "ro-d-members-load";
  const legacy = { ...smoke, id: "old-list", ir: { ...smoke.ir, assertions: [
    ...smoke.ir.assertions,
    { type: "ui" as const, target: { role: "row" }, minCount: 2, oracle: "human-approved" as const },
  ] } };
  const input = { detectionId: "d", targetMode: "real" as const, profile, tests: [smoke] };
  const before = businessCoverage(profile, input.tests, "real")[0]!;
  assert.deepEqual(before.evidence.map(ref => [ref.kind, ref.testId, ref.assertion.id]), [["route", smoke.id, "ok"]]);
  const list = planReadOnlyCases(input).find(candidate => candidate.ir.assertions.some(a => a.minCount === 2));
  assert.ok(list);
  assert.notEqual(list.testId, smoke.id);
  const approvedList = { ...smoke, id: list.testId, ir: list.ir };
  const tests = [smoke, approvedList];
  const after = businessCoverage(profile, tests, "real")[0]!;
  assert.deepEqual(after.evidence.filter(ref => ref.kind === "list").map(ref => [ref.testId, ref.assertion.id]),
    [[list.testId, "items"]]);
  assert.equal(planReadOnlyCases({ ...input, tests }).some(candidate => candidate.kind === "load"), false);
  const legacyCoverage = businessCoverage(profile, [legacy], "real")[0]!;
  assert.equal(legacyCoverage.evidence.some(ref => ref.kind === "list"), false);
  assert.ok(planReadOnlyCases({ ...input, tests: [legacy] }).some(c => c.ir.assertions.some(a => a.listRecords)));
  const oldSurface = profile.surfaces[0]!;
  delete oldSurface.recordList;
  oldSurface.listItemRole = "row";
  assert.equal(planReadOnlyCases(input).some(c => c.ir.assertions.some(a => a.listRecords)), false);
  assert.deepEqual(smoke.ir.assertions, [{ id: "ok", type: "ui", urlIncludes: "/members/", oracle: "human-approved" }]);
});

test("filter menu clicks and item text still visible in a list leave detail available", () => {
  const profile = listSurfaceProfile();
  profile.surfaces[0]!.elements.push({ role: "link", name: "Alice Chen" });
  const menu = approvedReal("/members/");
  menu.id = menu.ir.id = "ro-d-members-detail";
  menu.ir.steps.push({ id: "menu", action: "click", target: { role: "button", name: "筛选菜单" } });
  menu.ir.assertions.push({ id: "name", type: "ui", contains: "Alice Chen", oracle: "human-approved" });
  const linkOnly = { ...menu, id: "link-only", ir: { ...menu.ir, steps: [
    menu.ir.steps[0]!, { id: "select", action: "click" as const, target: { role: "link", name: "Alice Chen" } },
  ] } };
  const tests = [menu, linkOnly];
  const input = { detectionId: "d", profile, tests, targetMode: "real" as const };
  assert.equal(businessCoverage(profile, tests, "real")[0]!.evidence.some(ref => ref.kind === "detail"), false);
  const detail = planReadOnlyCases(input).find(candidate => candidate.kind === "detail");
  assert.ok(detail);
  assert.notEqual(detail.testId, menu.id);
  tests.push({ ...menu, id: detail.testId, ir: detail.ir });
  const refs = businessCoverage(profile, tests, "real")[0]!.evidence.filter(ref => ref.kind === "detail");
  assert.deepEqual(refs.map(ref => ref.assertion), detail.ir.assertions);
  assert.equal(planReadOnlyCases(input).some(candidate => candidate.kind === "detail"), false);
});

test("search reachability, a matching item, and filtering reference their own assertions", () => {
  const profile = listSurfaceProfile();
  const generated = planReadOnlyCases({ detectionId: "d", profile, tests: [], targetMode: "real" });
  const tests = generated.filter(c => c.kind === "search").map(c => ({ ...approvedReal(c.route), id: c.testId, ir: c.ir }));
  const [row] = businessCoverage(profile, tests, "real");
  assert.equal(row!.hasSearchSmoke, true);
  assert.deepEqual(row!.evidence.filter(ref => ref.kind.startsWith("search")).map(ref => [ref.kind, ref.assertion.id]),
    [["searchFilter", "filtered"], ["searchMatch", "match"]]);
  assert.equal(planReadOnlyCases({ detectionId: "d", profile, tests, targetMode: "real" }).some(c => c.kind === "search"), false);
  for (const t of tests) t.ir.steps = t.ir.steps.filter(s => s.action !== "fill");
  assert.equal(businessCoverage(profile, tests, "real")[0]!.evidence.some(ref => ref.kind.startsWith("search")), false);
});

test("unapproved, other-target, and earlier-page assertions cannot fill a route's gaps", () => {
  const profile = listSurfaceProfile();
  profile.surfaces.push({ route: "/other", elements: [] });
  const original = approvedReal("/members");
  original.ir.assertions.push({ type: "ui", target: { role: "table" }, listRecords: true, minCount: 2, oracle: "human-approved" });
  const wrongTarget = { ...original, ir: { ...original.ir, baseUrl: "https://elsewhere.invalid" } };
  const tests: StoredTest[] = [{ ...original, approvalStatus: "draft" }, wrongTarget];
  assert.ok(businessCoverage(profile, tests, "real").every(row => !row.evidence.length));
  original.ir.steps.push({ id: "move", action: "navigate", path: "/other" });
  const [members, other] = businessCoverage(profile, [original], "real");
  assert.equal(members!.evidence.length, 0);
  assert.deepEqual(other!.evidence.map(ref => ref.kind), ["list"]);
});

test("standalone iframe detail keeps its evidence when the stored shell has no header text", () => {
  const profile = { ...listSurfaceProfile(), surfaces: [], frameSurfaces: [{ route: "/members/", elements: [] }] };
  const contentElements = { "/members/": [
    { role: "columnheader", name: "成员姓名" }, { role: "link", name: "Alice Chen" },
  ] };
  const input = { detectionId: "d", targetMode: "real" as const, profile, contentElements };
  const detail = planReadOnlyCases({ ...input, tests: [] }).find(c => c.kind === "detail");
  assert.ok(detail);
  const tests = [{ ...approvedReal("/members/"), id: detail.testId, ir: detail.ir }];
  assert.equal(businessCoverage(profile, tests, "real")[0]!.evidence[0]?.kind, "detail");
  assert.equal(planReadOnlyCases({ ...input, tests }).some(c => c.kind === "detail"), false);
});

test("title and whole-page text cannot replace scoped search evidence", () => {
  const profile = listSurfaceProfile();
  const input = { detectionId: "d", profile, targetMode: "real" as const };
  const match = planReadOnlyCases({ ...input, tests: [] }).find(c => c.testId.endsWith("-search-match"))!;
  const matchAssertion = match.ir.assertions.find(a => a.id === "match")!;
  const oldAssertion = { type: "ui" as const, contains: matchAssertion.contains, notContains: "成员姓名", oracle: "human-approved" as const };
  const badScope = { ...matchAssertion, target: { role: "table", testId: "different-table" } };
  const noBaseline = { ...match.ir, steps: match.ir.steps.filter(step => !step.recordTexts) };
  for (const ir of [
    { ...match.ir, assertions: [oldAssertion] }, { ...match.ir, assertions: [badScope] }, noBaseline,
  ]) {
    const tests = [{ ...approvedReal("/members/"), id: match.testId, ir }];
    assert.equal(businessCoverage(profile, tests, "real")[0]!.evidence.some(ref => ref.kind.startsWith("search")), false);
    assert.ok(planReadOnlyCases({ ...input, tests }).some(c => c.testId.endsWith("-search-match")));
  }
});

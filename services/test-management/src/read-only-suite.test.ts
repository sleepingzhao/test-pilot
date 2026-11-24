import assert from "node:assert/strict";
import test from "node:test";
import type { DetectionReport } from "@testpilot/detect";
import { planReadOnlyCases } from "./read-only-suite.js";
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
      assertions: [{ id: "ok", type: "ui", contains: "联系人列表", oracle: "human-approved" }],
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

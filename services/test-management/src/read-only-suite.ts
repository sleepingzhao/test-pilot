import type { DetectionReport } from "@testpilot/detect";
import type { Locator, TestIR } from "@testpilot/test-ir";
import type { StoredTest } from "./store.js";

export type ReadOnlyCandidate = {
  testId: string;
  title: string;
  route: string;
  kind: "load" | "search";
  ir: TestIR;
  notes: string[];
};

const GENERIC_NAMES =
  /^(搜索.*|全部|部门|首页|返回|确定|取消|保存|提交|新建|添加|编辑|删除|上传|登录|退出|关闭|更多|查看|详情|操作|是|否)$/;

function routeKey(path: string): string {
  const trimmed = path.split("?")[0]!.split("#")[0]!.replace(/\/+$/, "");
  return trimmed || "/";
}

function slug(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "page";
}

function isRealTest(test: StoredTest, origin: string): boolean {
  if (test.ir.baseUrlRef === "real-env") return true;
  if (!test.ir.baseUrl) return false;
  try {
    return new URL(test.ir.baseUrl).origin === origin;
  } catch {
    return false;
  }
}

function coveredRoutes(
  profile: DetectionReport,
  tests: StoredTest[],
): { load: Set<string>; search: Set<string> } {
  let origin = "";
  try {
    origin = new URL(profile.target.url).origin;
  } catch {
    /* keep empty */
  }
  const load = new Set<string>();
  const search = new Set<string>();
  for (const test of tests) {
    if (test.approvalStatus !== "approved" || !isRealTest(test, origin)) continue;
    const fills = test.ir.steps.some((step) => step.action === "fill");
    for (const step of test.ir.steps) {
      if (step.action !== "navigate" || !step.path) continue;
      const route = routeKey(step.path);
      load.add(route);
      if (fills) search.add(route);
    }
  }
  return { load, search };
}

function elementKey(element: { testId?: string; name?: string }): string | undefined {
  if (element.testId) return `id:${element.testId}`;
  if (element.name) return `name:${element.name}`;
  return undefined;
}

/** Elements repeated across surfaces (top bar, sidebar) do not prove a route loaded. */
function globalKeys(surfaces: DetectionReport["surfaces"]): Set<string> {
  const counts = new Map<string, number>();
  for (const surface of surfaces) {
    const seen = new Set<string>();
    for (const element of surface.elements) {
      const key = elementKey(element);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  // Two appearances already means shared chrome; excluding a repeated tab is safer than asserting it.
  return new Set([...counts.entries()].filter(([, count]) => count >= 2).map(([key]) => key));
}

function stableTarget(
  surface: DetectionReport["surfaces"][number],
  global: Set<string>,
): Locator | undefined {
  const usable = surface.elements.filter((element) => {
    const key = elementKey(element);
    return !key || !global.has(key);
  });
  const byId = usable.find((element) => element.testId);
  if (byId?.testId) return { testId: byId.testId };
  const named = usable
    .filter((element) => {
      if (!element.name) return false;
      if (
        element.role === "input" ||
        element.role === "textarea" ||
        element.role === "select" ||
        element.role === "textbox" ||
        element.role === "combobox"
      ) {
        return false;
      }
      const name = element.name.trim();
      if (name.length < 2 || name.length > 30) return false;
      if (GENERIC_NAMES.test(name)) return false;
      if (/^\d+$/.test(name) || /\d{4,}/.test(name)) return false;
      return true;
    })
    .sort((a, b) => {
      const roleScore = (element: typeof a) =>
        element.role === "heading" || element.role === "tab" || element.role === "columnheader" ? 3 : element.role === "button" || element.role === "link" ? 2 : 1;
      return roleScore(b) - roleScore(a) || (b.name?.length ?? 0) - (a.name?.length ?? 0);
    });
  const best = named[0];
  if (!best?.name) return undefined;
  if (best.role === "heading" || best.role === "columnheader" || best.role === "tab" || best.role === "table" || best.role === "list" || best.role === "listitem" || best.role === "cell") {
    return { role: best.role, name: best.name };
  }
  return undefined;
}

function searchTarget(surface: DetectionReport["surfaces"][number]): Locator | undefined {
  const input = surface.elements.find((element) => {
    if (element.role !== "input" && element.role !== "textarea" && element.role !== "textbox") return false;
    const hint = element.placeholder ?? element.ariaLabel ?? element.name ?? "";
    return element.inputType === "search" || /搜索|search/i.test(hint);
  });
  if (!input) return undefined;
  if (input.placeholder) return { placeholder: input.placeholder };
  if (input.ariaLabel) return { label: input.ariaLabel };
  return undefined;
}

/**
 * Rule-based read-only drafts for real-target routes that no approved test visits.
 * Never enables mutation and never asserts absence it cannot prove; search cases only
 * prove the page stays usable after typing.
 */
export type SnapshotElement = {
  role?: string;
  name?: string;
  testId?: string;
  inputType?: string;
  placeholder?: string;
  ariaLabel?: string;
};

export function planReadOnlyCases(input: {
  detectionId: string;
  profile: DetectionReport;
  tests: StoredTest[];
  targetMode: "demo" | "custom" | "pilot" | "real";
  limit?: number;
  /** Standalone snapshots of iframe content routes; replaces shell-frame elements. */
  contentElements?: Record<string, SnapshotElement[]>;
  /** The exact standalone path that produced the snapshot (trailing slash matters). */
  contentPaths?: Record<string, string>;
}): ReadOnlyCandidate[] {
  if (input.targetMode !== "real") return [];
  const limit = Math.min(Math.max(input.limit ?? 12, 1), 20);
  const covered = coveredRoutes(input.profile, input.tests);
  const frameRoutes = new Set((input.profile.frameSurfaces ?? []).map((frame) => frame.route));
  const surfaces = [
    ...input.profile.surfaces.filter((surface) => !frameRoutes.has(surface.route)),
    ...(input.profile.frameSurfaces ?? []).map((frame) => ({
      route: frame.route,
      elements: input.contentElements?.[frame.route] ?? frame.elements,
    })),
  ];
  const global = globalKeys(surfaces);
  const seen = new Set<string>();
  const candidates: ReadOnlyCandidate[] = [];

  for (const surface of surfaces) {
    const contentPage = frameRoutes.has(surface.route);
    const route = routeKey(surface.route);
    if (route === "/" || seen.has(route)) continue;
    const stable = stableTarget(surface, global);
    const frameSurface = contentPage
      ? input.profile.frameSurfaces?.find((frame) => frame.route === surface.route)
      : undefined;
    const search = searchTarget(surface) ?? (frameSurface ? searchTarget(frameSurface) : undefined);
    const wantLoad = !covered.load.has(route);
    const wantSearch = Boolean(search) && !covered.search.has(route);
    if (!wantLoad && !wantSearch) continue;
    seen.add(route);
    const baseId = `ro-${slug(input.detectionId)}-${contentPage ? "content-" : ""}${slug(route)}`.slice(0, 110);
    const pageLabel = contentPage ? "内容页" : "";
    const pagePath = (contentPage ? input.contentPaths?.[surface.route] : undefined) ?? surface.route;
    const baseSteps = [{ id: "open", action: "navigate" as const, path: pagePath }];
    const policy = { screenshots: "never" as const, cleanup: "none" as const };

    if (wantLoad) candidates.push({
      testId: `${baseId}-load`,
      title: `真实只读·${pageLabel}${route} 加载`,
      route,
      kind: "load",
      notes: [
        contentPage
          ? `由画像中的 iframe 内容页 ${route} 自动生成；独立打开该内容页，断言路由与页面元素`
          : `由画像表面 ${route} 自动生成；断言路由 URL 落到该页面`,
        ...(stable ? ["附加断言目标来自该页面的非全局元素"] : ["该页只有全局元素，未生成可见性断言"]),
      ],
      ir: {
        id: `${baseId}-load`,
        version: 1,
        platform: "web",
        baseUrlRef: "real-env",
        steps: baseSteps,
        assertions: [
          { id: "routed", type: "ui", urlIncludes: pagePath, oracle: "human-approved" },
          ...(stable ? [{ id: "visible", type: "ui" as const, target: stable, oracle: "human-approved" as const }] : []),
        ],
        policy,
      },
    });

    if (wantSearch && search) {
      candidates.push({
        testId: `${baseId}-search`,
        title: `真实只读·${pageLabel}${route} 搜索冒烟`,
        route,
        kind: "search",
        notes: [
          `在 ${route} 的搜索框输入占位词，只验证页面仍可操作，不证明过滤结果`,
          "如需证明过滤，请补 contains + notContains 配对断言",
        ],
        ir: {
          id: `${baseId}-search`,
          version: 1,
          platform: "web",
          baseUrlRef: "real-env",
          steps: [
            { id: "open", action: "navigate", path: pagePath },
            { id: "wait-page", action: "wait", target: stable },
            { id: "search", action: "fill", target: search, value: "zzzz" },
          ],
          assertions: [
            { id: "routed", type: "ui", urlIncludes: pagePath, oracle: "human-approved" },
            ...(stable ? [{ id: "still-usable", type: "ui" as const, target: stable, oracle: "human-approved" as const }] : []),
          ],
          policy,
        },
      });
    }
    if (candidates.length >= limit) break;
  }
  return candidates.slice(0, limit);
}

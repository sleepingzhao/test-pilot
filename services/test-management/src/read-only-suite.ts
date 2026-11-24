import type { DetectionReport } from "@testpilot/detect";
import type { Locator, TestIR } from "@testpilot/test-ir";
import type { StoredTest } from "./store.js";

export type ReadOnlyCandidate = {
  testId: string;
  title: string;
  route: string;
  kind: "load" | "search" | "detail";
  ir: TestIR;
  notes: string[];
};

const GENERIC_NAMES =
  /^(搜索.*|全部|部门|首页|返回|确定|取消|保存|提交|新建|添加|编辑|删除|上传|登录|退出|关闭|更多|查看|详情|操作|是|否)$/;

const ITEM_ROLES = new Set(["row", "listitem", "cell", "link", "option"]);

/** Tabs and filter bars often render as `li`, so list-item roles alone do not prove content. */
const FILTER_LABEL_PREFIX =
  /^(全部|所有|今天|未来|已完成|未完成|进行中|待办事项?|我负责|我创建|我分配|快速访问|概览)/;

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
): { load: Set<string>; searchMatch: Set<string>; searchNone: Set<string>; searchSmoke: Set<string>; detail: Set<string> } {
  let origin = "";
  try {
    origin = new URL(profile.target.url).origin;
  } catch {
    /* keep empty */
  }
  const load = new Set<string>();
  const searchMatch = new Set<string>();
  const searchNone = new Set<string>();
  const searchSmoke = new Set<string>();
  const detail = new Set<string>();
  for (const test of tests) {
    if (test.approvalStatus !== "approved" || !isRealTest(test, origin)) continue;
    const fills = test.ir.steps.some((step) => step.action === "fill");
    const clicks = test.ir.steps.some((step) => step.action === "click");
    const hasContains = test.ir.assertions.some((assertion) => assertion.contains);
    const hasNotContains = test.ir.assertions.some((assertion) => assertion.notContains);
    for (const step of test.ir.steps) {
      if (step.action !== "navigate" || !step.path) continue;
      const route = routeKey(step.path);
      load.add(route);
      if (fills) {
        if (hasContains) searchMatch.add(route);
        if (hasNotContains) searchNone.add(route);
        if (test.ir.assertions.length) searchSmoke.add(route);
      }
      if (clicks) detail.add(route);
    }
  }
  return { load, searchMatch, searchNone, searchSmoke, detail };
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

type SnapshotElement = {
  role?: string;
  name?: string;
  testId?: string;
  inputType?: string;
  placeholder?: string;
  ariaLabel?: string;
};

function surfaceElements(
  surface: DetectionReport["surfaces"][number],
  global: Set<string>,
): SnapshotElement[] {
  return surface.elements.filter((element) => {
    const key = elementKey(element);
    return !key || !global.has(key);
  });
}

function letterCount(text: string): number {
  const matches = text.match(/[\p{L}\p{Script=Han}]/gu);
  return matches?.length ?? 0;
}

function itemRolePriority(role?: string): number {
  if (role === "link" || role === "cell" || role === "listitem") return 3;
  if (role === "option") return 2;
  if (role === "row") return 1;
  return 0;
}


function filterFallbackItemTexts(
  texts: string[],
  surface: DetectionReport["surfaces"][number],
): string[] {
  // Tabs often render a counter ("未来 0"); compare the label core so chrome cannot pass as an item.
  const coreName = (text: string) => text.replace(/[\s\d·—–-]+$/g, "").trim().toLowerCase();
  // Any text that already names an element is chrome or a control, never a repeated-card payload.
  const chromeNames = new Set(
    surface.elements
      .filter((element) => element.name)
      .map((element) => coreName(element.name!)),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of texts) {
    const name = raw.trim();
    if (name.length < 4 || name.length > 40) continue;
    if (letterCount(name) < 2) continue;
    if (GENERIC_NAMES.test(name)) continue;
    if (FILTER_LABEL_PREFIX.test(name)) continue;
    if (!name.replace(/\s/g, "")) continue;
    const key = name.toLowerCase();
    if (chromeNames.has(coreName(name))) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= 8) break;
  }
  return out;
}

function itemTextsFromElements(surface: DetectionReport["surfaces"][number], global: Set<string>): string[] {
  const headerNames = new Set(
    surface.elements
      .filter((element) => element.role === "columnheader" && element.name)
      .map((element) => element.name!.trim().toLowerCase()),
  );
  const seen = new Set<string>();
  const ranked: Array<{ text: string; priority: number; length: number }> = [];
  for (const element of surfaceElements(surface, global)) {
    if (!element.role || !ITEM_ROLES.has(element.role) || !element.name) continue;
    const name = element.name.trim();
    if (name.length < 4 || name.length > 40) continue;
    if (letterCount(name) < 2) continue;
    if (GENERIC_NAMES.test(name)) continue;
    if ((element.role === "listitem" || element.role === "option") && FILTER_LABEL_PREFIX.test(name)) continue;
    if (headerNames.has(name.toLowerCase())) continue;
    if (!name.replace(/\s/g, "")) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ranked.push({ text: name, priority: itemRolePriority(element.role), length: name.length });
  }
  ranked.sort((a, b) => b.priority - a.priority || a.length - b.length || a.text.localeCompare(b.text));
  return ranked.slice(0, 8).map((item) => item.text);
}

export function itemTexts(
  surface: DetectionReport["surfaces"][number],
  global: Set<string>,
  contentTexts?: string[],
): string[] {
  const fromElements = itemTextsFromElements(surface, global);
  if (fromElements.length) return fromElements;
  if (contentTexts?.length) return filterFallbackItemTexts(contentTexts, surface);
  return [];
}

export function structuralTarget(
  surface: DetectionReport["surfaces"][number],
  global: Set<string>,
): { target: Locator; minCount: number } | undefined {
  const usable = surfaceElements(surface, global);
  const roles: Array<{ role: string; minNamed: number; minCount: number }> = [
    { role: "row", minNamed: 2, minCount: 2 },
    { role: "listitem", minNamed: 2, minCount: 2 },
    { role: "cell", minNamed: 3, minCount: 2 },
  ];
  for (const spec of roles) {
    const named = usable.filter((element) => element.role === spec.role && element.name?.trim());
    if (named.length < spec.minNamed) continue;
    const names = named.map((element) => element.name!.trim());
    if (new Set(names).size === 1) continue;
    return { target: { role: spec.role }, minCount: spec.minCount };
  }
  return undefined;
}

export function columnHeaderTexts(surface: DetectionReport["surfaces"][number], global: Set<string>): string[] {
  const seen = new Set<string>();
  const headers: string[] = [];
  for (const element of surfaceElements(surface, global)) {
    if (element.role !== "columnheader" || !element.name) continue;
    const name = element.name.trim();
    if (name.length < 4 || name.length > 30) continue;
    if (GENERIC_NAMES.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    headers.push(name);
    if (headers.length >= 3) break;
  }
  return headers;
}

export function itemLink(
  surface: DetectionReport["surfaces"][number],
  global: Set<string>,
  texts: string[],
): Locator | undefined {
  if (!texts.length) return undefined;
  const textSet = new Set(texts.map((text) => text.trim()));
  for (const element of surfaceElements(surface, global)) {
    if (element.role !== "link" || !element.name) continue;
    const name = element.name.trim();
    if (textSet.has(name)) return { role: "link", name };
  }
  return undefined;
}

function stableTarget(
  surface: DetectionReport["surfaces"][number],
  global: Set<string>,
): Locator | undefined {
  const usable = surfaceElements(surface, global);
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

function waitPageSteps(stable: Locator | undefined): TestIR["steps"] {
  return stable ? [{ id: "wait-page", action: "wait", target: stable }] : [];
}

/**
 * Rule-based read-only drafts for real-target routes that no approved test visits.
 * Never enables mutation. Structure and filtering claims come from paired assertions; a lone
 * notContains or a single element is not enough to prove a list rendered.
 */
export { type SnapshotElement };

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
  /** Repeated block texts from content exploration when element names are missing. */
  contentTexts?: Record<string, string[]>;
}): ReadOnlyCandidate[] {
  if (input.targetMode !== "real") return [];
  const limit = Math.min(Math.max(input.limit ?? 24, 1), 40);
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
    const itemsFromElements = itemTextsFromElements(surface, global);
    const items = itemsFromElements.length
      ? itemsFromElements
      : filterFallbackItemTexts(input.contentTexts?.[surface.route] ?? [], surface);
    const itemsFromElementsOnly = itemsFromElements.length > 0;
    const struct = structuralTarget(surface, global);
    const headers = columnHeaderTexts(surface, global);
    const link = itemLink(surface, global, itemsFromElementsOnly ? items : []);
    const wantLoad = !covered.load.has(route);
    const wantSearch =
      Boolean(search) &&
      (items.length > 0
        ? !covered.searchMatch.has(route) || !covered.searchNone.has(route)
        : !covered.searchSmoke.has(route));
    const wantDetail =
      itemsFromElementsOnly && Boolean(link) && headers.length > 0 && items.length > 0 && !covered.detail.has(route);
    if (!wantLoad && !wantSearch && !wantDetail) continue;
    seen.add(route);
    const baseId = `ro-${slug(input.detectionId)}-${contentPage ? "content-" : ""}${slug(route)}`.slice(0, 110);
    const pageLabel = contentPage ? "内容页" : "";
    const pagePath = (contentPage ? input.contentPaths?.[surface.route] : undefined) ?? surface.route;
    const baseSteps = [{ id: "open", action: "navigate" as const, path: pagePath }];
    const policy = { screenshots: "never" as const, cleanup: "none" as const };

    if (wantLoad) {
      candidates.push({
        testId: `${baseId}-load`,
        title: `真实只读·${pageLabel}${route} 加载`,
        route,
        kind: "load",
        notes: [
          contentPage
            ? `由画像中的 iframe 内容页 ${route} 自动生成；独立打开该内容页，断言路由与页面元素`
            : `由画像表面 ${route} 自动生成；断言路由 URL 落到该页面`,
          ...(stable ? ["附加断言目标来自该页面的非全局元素"] : ["该页只有全局元素，未生成可见性断言"]),
          ...(struct ? ["附加列表行数断言（minCount）证明列表已渲染"] : []),
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
            ...(struct
              ? [
                  {
                    id: "items",
                    type: "ui" as const,
                    target: struct.target,
                    minCount: struct.minCount,
                    oracle: "human-approved" as const,
                  },
                ]
              : []),
          ],
          policy,
        },
      });
    }

    if (wantSearch && search) {
      if (items.length > 0) {
        const afterOpen = [...baseSteps, ...waitPageSteps(stable)];
        const matchSteps: TestIR["steps"] = [
          ...afterOpen,
          { id: "search-fill", action: "fill", target: search, value: items[0]! },
          { id: "search-submit", action: "press", key: "Enter" },
        ];
        const itemInRoute = route.toLowerCase().includes(items[0]!.toLowerCase());
        if (!covered.searchMatch.has(route)) candidates.push({
          testId: `${baseId}-search-match`,
          title: `真实只读·${pageLabel}${route} 搜索命中`,
          route,
          kind: "search",
          notes: [
            `在 ${route} 搜索真实列表项「${items[0]}」，断言页面仍包含该项`,
            "只读：仅 fill + Enter，无其它写操作",
          ],
          ir: {
            id: `${baseId}-search-match`,
            version: 1,
            platform: "web",
            baseUrlRef: "real-env",
            steps: matchSteps,
            assertions: [
              { id: "routed", type: "ui", urlIncludes: pagePath, oracle: "human-approved" },
              ...(stable ? [{ id: "still-usable", type: "ui" as const, target: stable, oracle: "human-approved" as const }] : []),
              { id: "match", type: "ui", contains: items[0], oracle: "human-approved" },
            ],
            policy,
          },
        });

        if (!itemInRoute && !covered.searchNone.has(route)) {
          const noneSteps: TestIR["steps"] = [
            ...afterOpen,
            { id: "search-fill", action: "fill", target: search, value: "zzqqxx" },
            { id: "search-submit", action: "press", key: "Enter" },
          ];
          candidates.push({
            testId: `${baseId}-search-none`,
            title: `真实只读·${pageLabel}${route} 搜索过滤`,
            route,
            kind: "search",
            notes: [
              `搜索无命中词后，路由仍在 ${route}，且先前可见的「${items[0]}」不再出现`,
              "urlIncludes + notContains 配对断言，避免空页面误判",
            ],
            ir: {
              id: `${baseId}-search-none`,
              version: 1,
              platform: "web",
              baseUrlRef: "real-env",
              steps: noneSteps,
              assertions: [
                { id: "routed", type: "ui", urlIncludes: pagePath, oracle: "human-approved" },
                ...(stable ? [{ id: "still-usable", type: "ui" as const, target: stable, oracle: "human-approved" as const }] : []),
                { id: "filtered", type: "ui", urlIncludes: pagePath, notContains: items[0], oracle: "human-approved" },
              ],
              policy,
            },
          });
        }
      } else {
        const smokeSteps: TestIR["steps"] = [
          ...baseSteps,
          ...waitPageSteps(stable),
          { id: "search", action: "fill", target: search, value: "zzzz" },
        ];
        candidates.push({
          testId: `${baseId}-search`,
          title: `真实只读·${pageLabel}${route} 搜索冒烟`,
          route,
          kind: "search",
          notes: [
            `在 ${route} 的搜索框输入占位词，只验证页面仍可操作，不证明过滤结果`,
            "画像中无可用于语义搜索的列表项，保留冒烟用例",
          ],
          ir: {
            id: `${baseId}-search`,
            version: 1,
            platform: "web",
            baseUrlRef: "real-env",
            steps: smokeSteps,
            assertions: [
              { id: "routed", type: "ui", urlIncludes: pagePath, oracle: "human-approved" },
              ...(stable ? [{ id: "still-usable", type: "ui" as const, target: stable, oracle: "human-approved" as const }] : []),
            ],
            policy,
          },
        });
      }
    }

    if (wantDetail && link && headers[0]) {
      const detailSteps: TestIR["steps"] = [
        ...baseSteps,
        ...waitPageSteps(stable),
        { id: "open-item", action: "click", target: link },
      ];
      candidates.push({
        testId: `${baseId}-detail`,
        title: `真实只读·${pageLabel}${route} 详情`,
        route,
        kind: "detail",
        notes: [
          `点击列表项「${link.name}」进入详情；断言详情含该项且列表表头「${headers[0]}」不再出现`,
          "只读：仅点击链接，不触发写操作",
        ],
        ir: {
          id: `${baseId}-detail`,
          version: 1,
          platform: "web",
          baseUrlRef: "real-env",
          steps: detailSteps,
          assertions: [
            {
              id: "detail",
              type: "ui",
              contains: link.name,
              notContains: headers[0],
              oracle: "human-approved",
            },
          ],
          policy,
        },
      });
    }

    if (candidates.length >= limit) break;
  }
  return candidates.slice(0, limit);
}
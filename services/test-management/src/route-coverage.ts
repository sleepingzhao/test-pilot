import type { DetectionReport, RouteCoverageRow, RouteEvidence, SurfaceSnapshot } from "@testpilot/detect";
import type { TestStep } from "@testpilot/test-ir";
import { buildRunEnvironment } from "./run-env.js";
import type { StoredTest } from "./store.js";

export function routeKey(path: string): string {
  return path.split(/[?#]/, 1)[0]!.replace(/\/+$/, "") || "/";
}

function sameOriginRoute(path: string, base: string, origin: string): string | undefined {
  try {
    const url = new URL(path, base);
    if (url.origin === origin) return routeKey(url.pathname);
  } catch {
    // A malformed or unresolved target cannot supply evidence for this profile.
  }
}

type PageElements = SurfaceSnapshot["elements"];

function isSearchInput(step: TestStep, elements: PageElements): boolean {
  const target = step.target;
  if (step.action !== "fill" || !target) return false;
  return [target.placeholder, target.label, target.name, target.testId, target.css].some(
    hint => hint && /search|搜索|查询/i.test(hint),
  ) || elements.some(el => el.inputType === "search" && (
    (el.testId && el.testId === target.testId) || (el.placeholder && el.placeholder === target.placeholder) ||
    (el.ariaLabel && el.ariaLabel === target.label)
  ));
}

function selectedDetail(steps: TestStep[], item: string, excluded: string, elements: PageElements): boolean {
  const clickIndex = steps.map(step => step.action).lastIndexOf("click");
  const target = steps[clickIndex]?.target;
  if (target?.role !== "link" || target.name !== item || item === excluded) return false;
  if (elements.some(el => el.inNav && el.role === "link" && el.name === item)) return false;
  return elements.some(el => el.role === "columnheader" && el.name === excluded) ||
    steps.slice(0, clickIndex).some(step => step.action === "wait" &&
      step.target?.role === "columnheader" && step.target.name === excluded);
}

/** UI assertions execute after the steps, on the final page of their own actor. */
export function businessCoverage(profile: DetectionReport, tests: StoredTest[], mode: string): RouteCoverageRow[] {
  const pages = [...profile.surfaces, ...(profile.frameSurfaces ?? [])];
  const rows = new Map<string, RouteCoverageRow>();
  const elementsByRoute = new Map<string, PageElements>();
  for (const page of pages) {
    const route = routeKey(page.route);
    elementsByRoute.set(route, [...(elementsByRoute.get(route) ?? []), ...page.elements]);
    if (!rows.has(route)) rows.set(route, { route, evidence: [], hasSearchSmoke: false });
  }
  const env = buildRunEnvironment();
  const refs = { ...env.baseUrlRefs };
  if (mode === "real" && !refs["real-env"]) refs["real-env"] = profile.target.url;
  if (mode === "pilot" && !refs["pilot-admin"]) refs["pilot-admin"] = profile.target.url;
  const origin = new URL(profile.target.url).origin;
  for (const { id, title, approvalStatus, ir } of tests) {
    if (approvalStatus !== "approved") continue;
    for (const [index, a] of ir.assertions.entries()) {
      if (a.type !== "ui" || (a.provider && a.provider !== "playwright-ui")) continue;
      const actorId = a.actor ?? "primary";
      const actor = ir.actors?.find(actor => actor.id === actorId);
      const actorBase = actor?.baseUrl ?? (actor?.baseUrlRef ? refs[actor.baseUrlRef] : undefined);
      const base = actorBase || ir.baseUrl || (ir.baseUrlRef ? refs[ir.baseUrlRef] : env.baseUrl);
      if (!base) continue;
      const steps = ir.steps.filter(step => (step.actor ?? "primary") === actorId);
      const nav = steps.map(s => s.action).lastIndexOf("navigate");
      if (nav < 0) continue;
      const path = steps[nav]!.path ?? "/";
      const route = sameOriginRoute(path, base, origin);
      const row = route && rows.get(route);
      if (!row) continue;
      const add = (kind: RouteEvidence["kind"]) => {
        row.evidence.push({ kind, testId: id, title, index, assertion: a });
      };
      const checksRoute = a.urlIncludes && /^(?:\/|https?:\/\/)/i.test(a.urlIncludes) && a.urlIncludes !== "/" &&
        sameOriginRoute(a.urlIncludes, base, origin) === route;
      if (checksRoute) add("route");
      // A frame locator on a shell page does not identify a content route.
      if (a.frame) continue;
      if (a.listRecords && (a.minCount ?? 0) >= 2 && ["table", "grid", "list"].includes(a.target?.role ?? "")) add("list");
      const actions = steps.slice(nav + 1).filter(step => !step.frame);
      const elements = elementsByRoute.get(row.route) ?? [];
      const fill = actions.filter(step => isSearchInput(step, elements)).at(-1);
      if (fill && checksRoute) row.hasSearchSmoke = true;
      if (fill?.value && a.contains === fill.value) add("searchMatch");
      const excluded = a.notContains;
      if (fill && excluded && excluded !== fill.value) {
        const excludesHeader = elements.some(el => el.role === "columnheader" && el.name === excluded);
        const excludesItem = elements.some(el => !el.inNav && el.name === excluded &&
          ["row", "listitem", "cell", "link", "option"].includes(el.role ?? ""));
        if (!excludesHeader && (excludesItem || (!a.contains && (checksRoute || a.target)))) add("searchFilter");
      }
      // The item must be selected and asserted, with evidence that the list view was left.
      if (a.contains && a.notContains && selectedDetail(actions, a.contains, a.notContains, elements)) add("detail");
    }
  }
  return [...rows.values()];
}

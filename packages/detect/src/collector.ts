import type { Frame, Locator, Page } from "playwright";
import { snapshotPageContext } from "@testpilot/context-web";
import { evaluateCapabilities } from "./rules.js";
import {
  classifySignals,
  normalizeNetworkUrl,
  type DomObservation,
  type NetworkObservation,
} from "./signals.js";
import type {
  DetectionEvidence,
  DetectionReport,
  Signal,
  SignalId,
  SurfaceSnapshot,
} from "./types.js";

/** Passive profile. Same shape as the v1 detection report; the collector does not extend it. */
export type SystemProfile = DetectionReport;

export type CollectSystemProfileOptions = {
  /** Route budget, including the starting page. Default 12. */
  maxRoutes?: number;
  /** Quiet period after navigation, reload, or a view switch. Default 1200. */
  settleMs?: number;
  /** Timeout for goto and reload. Default 20000. */
  routeTimeoutMs?: number;
  /** Wait this long for a collapsed sidebar's expand control before discovery. */
  expandWaitMs?: number;
};

type Timing = {
  settleMs: number;
  routeTimeoutMs: number;
  expandWaitMs?: number;
  discover: boolean;
  reload: boolean;
  gotoUrl?: string;
};

type SpaTarget = {
  name: string;
  testId?: string;
  role?: string;
};

type Sample = {
  surface: SurfaceSnapshot;
  signals: Signal[];
  routes: string[];
  spa: SpaTarget[];
  evidence: {
    page: DetectionEvidence["pages"][number];
    frames: DetectionEvidence["frames"];
    endpoints: DetectionEvidence["endpoints"];
  };
};

const OPEN_FORM =
  /^(?:添加|新增|创建|新建|提交工单|打开表单|add(?:\b|\s|$)|create(?:\b|\s|$)|new(?:\b|\s|$))/i;
const BLOCKED_NAME = /^(?:保存|提交|确认|确定|删除|移除|save|submit|confirm|delete|remove)$/i;
const NAV_SELECTOR = [
  "nav a[href]",
  "[role='navigation'] a[href]",
  "aside a[href]",
  "[role='complementary'] a[href]",
  "[class*='sidebar'] a[href]",
  "[class*='sider'] a[href]",
  "nav button",
  "[role='navigation'] button",
  "nav [role='menuitem']",
  "[role='navigation'] [role='menuitem']",
  "[role='tab']",
  "aside button",
  "aside [role='menuitem']",
  "[role='complementary'] button",
  "[role='complementary'] [role='menuitem']",
  "[class*='sidebar'] button",
  "[class*='sider'] button",
  "[role='button']",
].join(", ");

/**
 * Read-only capability probe. The caller logs in and passes that page.
 * This function does not launch a browser, type credentials, or submit forms.
 */
export async function collectSystemProfile(
  page: Page,
  options?: CollectSystemProfileOptions,
): Promise<SystemProfile> {
  const maxRoutes = Math.max(1, options?.maxRoutes ?? 12);
  const timing = {
    settleMs: Math.max(0, options?.settleMs ?? 1200),
    routeTimeoutMs: Math.max(1000, options?.routeTimeoutMs ?? 20_000),
    expandWaitMs: Math.max(0, options?.expandWaitMs ?? 0),
  };
  const entryUrl = page.url();
  const surfaces: SurfaceSnapshot[] = [];
  const found: Signal[] = [];
  const evidence: DetectionEvidence = { pages: [], frames: [], endpoints: [] };
  const onDialog = (dialog: { dismiss: () => Promise<void> }) => {
    void dialog.dismiss().catch(() => undefined);
  };
  page.on("dialog", onDialog);

  try {
    if (!isHttpUrl(entryUrl)) {
      const sampled = await samplePage(page, { ...timing, discover: false, reload: false });
      if (sampled) {
        surfaces.push(sampled.surface);
        found.push(...sampled.signals);
        mergeEvidence(evidence, sampled.evidence);
      }
    } else {
      const queue = [entryUrl];
      const seen = new Set<string>([pathOf(entryUrl)]);
      const spaSeen = new Set<string>();
      let spaClicks = 0;
      let first = true;
      while (queue.length > 0 && surfaces.length < maxRoutes) {
        const target = queue.shift();
        if (!target) break;
        let sampled: Sample | undefined;
        try {
          sampled = await samplePage(page, {
            ...timing,
            discover: true,
            reload: first,
            gotoUrl: first ? undefined : target,
          });
        } catch {
          sampled = undefined;
        }
        first = false;
        if (!sampled) continue;
        surfaces.push(sampled.surface);
        found.push(...sampled.signals);
        mergeEvidence(evidence, sampled.evidence);
        seen.add(pathOf(page.url()));
        for (const href of sampled.routes) {
          const path = pathOf(href);
          if (seen.has(path) || seen.size >= maxRoutes) continue;
          seen.add(path);
          queue.push(href);
        }
        for (const item of sampled.spa) {
          if (spaClicks >= maxRoutes) break;
          const key = item.testId ? `id:${item.testId}` : `name:${item.name}`;
          if (spaSeen.has(key)) continue;
          spaSeen.add(key);
          spaClicks += 1;
          try {
            const extra = await collectSpaView(page, item, timing);
            if (extra) {
              found.push(...extra.signals);
              mergeEvidence(evidence, extra.evidence);
            }
          } catch {
            // One view switch must not abort the rest of the crawl.
          }
        }
      }
    }
  } finally {
    page.off("dialog", onDialog);
  }

  const signals = mergeSignals(found);
  const evaluated = evaluateCapabilities({ signals, surfaces });
  evidence.pages = evidence.pages.slice(0, 8);
  evidence.frames = evidence.frames.slice(0, 8);
  evidence.endpoints = evidence.endpoints.slice(0, 150);
  return {
    version: 1,
    target: { url: entryUrl, mode: "passive" },
    surfaces,
    signals,
    capabilities: evaluated.capabilities,
    questions: evaluated.questions,
    evidence,
  };
}

function mergeEvidence(
  target: DetectionEvidence,
  source: {
    page: DetectionEvidence["pages"][number];
    frames: DetectionEvidence["frames"];
    endpoints: DetectionEvidence["endpoints"];
  },
): void {
  const pageKey = `${source.page.route}\u0000${source.page.text.slice(0, 300)}`;
  if (!target.pages.some((page) => `${page.route}\u0000${page.text.slice(0, 300)}` === pageKey)) {
    target.pages.push(source.page);
  }
  for (const frame of source.frames) {
    const key = `${frame.route}\u0000${frame.text.slice(0, 300)}`;
    if (!target.frames.some((item) => `${item.route}\u0000${item.text.slice(0, 300)}` === key)) {
      target.frames.push(frame);
    }
  }
  for (const endpoint of source.endpoints) {
    if (
      !target.endpoints.some(
        (item) =>
          item.method === endpoint.method &&
          item.path === endpoint.path &&
          item.status === endpoint.status,
      )
    ) {
      target.endpoints.push(endpoint);
    }
  }
}

async function samplePage(page: Page, timing: Timing): Promise<Sample | undefined> {
  const watch = attachNetwork(page);
  try {
    if (timing.gotoUrl) {
      await page.goto(timing.gotoUrl, { waitUntil: "domcontentloaded", timeout: timing.routeTimeoutMs });
    } else if (timing.reload) {
      try {
        await page.reload({ waitUntil: "domcontentloaded", timeout: timing.routeTimeoutMs });
      } catch {
        // Keep the DOM the caller already authenticated into.
      }
    }
    await page.waitForTimeout(timing.settleMs);
    await expandSidebar(page, timing.expandWaitMs ?? 0);
    const discovered = timing.discover ? await discoverLinks(page) : { routes: [], spa: [] };
    const baseDom = await observeDom(page);
    const opened = await readOpenedForm(page, baseDom, timing);
    const surface = await readSurface(page);
    const frames = await collectFrames(page);
    const pageText = await readPageText(page);
    await closeOpenedForm(page, opened.beforeUrl, timing.routeTimeoutMs);
    return {
      surface,
      signals: [
        ...classifySignals({ route: surface.route, dom: opened.dom, network: watch.records.slice() }),
        ...frames.signals,
      ],
      routes: discovered.routes,
      spa: discovered.spa,
      evidence: {
        page: {
          route: surface.route,
          title: surface.title,
          text: pageText,
          elements: surface.elements,
        },
        frames: frames.frames,
        endpoints: endpointsFrom(watch.records),
      },
    };
  } finally {
    watch.detach();
  }
}

async function collectSpaView(
  page: Page,
  item: SpaTarget,
  timing: Omit<Timing, "discover" | "reload" | "gotoUrl">,
): Promise<
  | {
      signals: Signal[];
      evidence: {
        page: DetectionEvidence["pages"][number];
        frames: DetectionEvidence["frames"];
        endpoints: DetectionEvidence["endpoints"];
      };
    }
  | undefined
> {
  if (isForbiddenName(item.name)) return undefined;
  const before = page.url();
  const watch = attachNetwork(page);
  try {
    await expandSidebar(page, 1_500);
    const clicked = await clickSpa(page, item);
    if (!clicked) return undefined;
    await page.waitForTimeout(timing.settleMs);
    if (!sameOrigin(before, page.url()) || isLogout(page.url(), item.name)) {
      await restore(page, before, timing.routeTimeoutMs);
      return undefined;
    }
    const baseDom = await observeDom(page);
    const opened = await readOpenedForm(page, baseDom, timing);
    const route = pathOf(page.url());
    const frames = await collectFrames(page);
    const signals = [
      ...classifySignals({ route, dom: opened.dom, network: watch.records.slice() }),
      ...frames.signals,
    ];
    const pageText = await readPageText(page);
    const title = await page.title().catch(() => undefined);
    await closeOpenedForm(page, opened.beforeUrl, timing.routeTimeoutMs);
    if (!samePlace(before, page.url())) await restore(page, before, timing.routeTimeoutMs);
    return {
      signals,
      evidence: {
        page: {
          route,
          title,
          text: pageText,
          elements: evidenceElements(opened.dom),
        },
        frames: frames.frames,
        endpoints: endpointsFrom(watch.records),
      },
    };
  } catch {
    await restore(page, before, timing.routeTimeoutMs);
    return undefined;
  } finally {
    watch.detach();
  }
}

function attachNetwork(page: Page): { records: NetworkObservation[]; detach: () => void } {
  const records: NetworkObservation[] = [];
  const seen = new Set<string>();
  const keep = new Set(["xhr", "fetch", "document", "websocket", "eventsource"]);
  const push = (item: NetworkObservation) => {
    if (records.length >= 100) return;
    const key = [item.method, item.url, item.status ?? "", item.resourceType, item.contentType ?? "", item.websocket ? "1" : "0"].join(" ");
    if (seen.has(key)) return;
    seen.add(key);
    records.push(item);
  };
  const onResponse = (response: { url: () => string; status: () => number; headers: () => Record<string, string>; request: () => { method: () => string; resourceType: () => string; headers: () => Record<string, string> } }) => {
    try {
      const request = response.request();
      const resourceType = request.resourceType();
      if (!keep.has(resourceType)) return;
      const rawUrl = response.url();
      if (!/^(https?:|wss?:)/i.test(rawUrl)) return;
      const contentType = response.headers()["content-type"]?.split(";")[0]?.trim().toLowerCase();
      let requestContentType: string | undefined;
      try {
        requestContentType = request.headers()["content-type"]?.split(";")[0]?.trim().toLowerCase();
      } catch {
        requestContentType = undefined;
      }
      push({
        url: normalizeNetworkUrl(rawUrl),
        method: request.method(),
        status: response.status(),
        resourceType,
        contentType,
        requestContentType,
        websocket: resourceType === "websocket",
      });
    } catch {
      // A single unreadable response is not a failed probe.
    }
  };
  const onSocket = (socket: { url: () => string }) => {
    try {
      const rawUrl = socket.url();
      if (!/^(https?:|wss?:)/i.test(rawUrl)) return;
      push({
        url: normalizeNetworkUrl(rawUrl),
        method: "GET",
        resourceType: "websocket",
        websocket: true,
      });
    } catch {
      // Ignore sockets without a usable URL.
    }
  };
  page.on("response", onResponse);
  page.on("websocket", onSocket);
  return {
    records,
    detach: () => {
      page.off("response", onResponse);
      page.off("websocket", onSocket);
    },
  };
}

async function readSurface(page: Page): Promise<SurfaceSnapshot> {
  const snapshot = await snapshotPageContext(page);
  const title = await page.title();
  return {
    route: pathOf(page.url()),
    title: title || undefined,
    elements: snapshot.elements,
  };
}

async function readOpenedForm(
  page: Page,
  before: DomObservation[],
  timing: { settleMs: number; routeTimeoutMs: number },
): Promise<{ dom: DomObservation[]; beforeUrl: string }> {
  const beforeUrl = page.url();
  for (const candidate of before.filter(isOpenTarget)) {
    const clicked = await clickNamed(page, candidate);
    if (!clicked) continue;
    await page.waitForTimeout(timing.settleMs);
    if (!samePlace(beforeUrl, page.url())) {
      await restore(page, beforeUrl, timing.routeTimeoutMs);
      return { dom: before, beforeUrl };
    }
    const after = await observeDom(page);
    return { dom: withOpenedForm(before, after), beforeUrl };
  }
  return { dom: before, beforeUrl };
}

async function closeOpenedForm(page: Page, beforeUrl: string, timeout: number): Promise<void> {
  if (!samePlace(page.url(), beforeUrl)) {
    await restore(page, beforeUrl, timeout);
    return;
  }
  await page.keyboard.press("Escape").catch(() => undefined);
  const cancel = page.getByRole("button", { name: /^(取消|cancel)$/i }).filter({ visible: true }).first();
  if ((await cancel.isVisible().catch(() => false)) && !(await isSubmitControl(cancel))) {
    await cancel.click({ timeout: 1500 }).catch(() => undefined);
  }
}

async function clickNamed(page: Page, el: DomObservation): Promise<boolean> {
  const name = (el.name ?? "").trim();
  if (!isOpenTarget({ ...el, name })) return false;
  const role = el.tag === "a" || el.role === "link" ? "link" : "button";
  const locator = (el.testId
    ? page.getByTestId(el.testId)
    : page.getByRole(role, { name, exact: true })
  ).filter({ visible: true }).first();
  try {
    if (!(await locator.isVisible().catch(() => false))) return false;
    if (await isSubmitControl(locator)) return false;
    const live = ((await locator.getAttribute("aria-label")) || (await locator.innerText()) || "").replace(/\s+/g, " ").trim();
    if (!isOpenTarget({ ...el, name: live })) return false;
    await locator.click({ timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

async function expandSidebar(page: Page, waitMs = 0): Promise<void> {
  const expand = page
    .getByRole("button", { name: /展开侧栏|展开导航|展开菜单|open sidebar|expand sidebar/i })
    .filter({ visible: true })
    .first();
  if (waitMs > 0) {
    await expand.waitFor({ state: "visible", timeout: waitMs }).catch(() => undefined);
  }
  if (!(await expand.isVisible().catch(() => false))) return;
  await expand.click({ timeout: 1_500 }).catch(() => undefined);
  await page.waitForTimeout(800);
}

async function clickSpa(page: Page, item: SpaTarget): Promise<boolean> {  if (isForbiddenName(item.name)) return false;
  try {
    const located = item.testId
      ? page.getByTestId(item.testId).filter({ visible: true }).first()
      : item.role === "tab"
        ? page.getByRole("tab", { name: item.name, exact: true }).filter({ visible: true }).first()
        : item.role === "menuitem"
          ? page.getByRole("menuitem", { name: item.name, exact: true }).filter({ visible: true }).first()
          : page.getByRole("link", { name: item.name, exact: true }).filter({ visible: true }).first();
    const button = page.getByRole("button", { name: item.name, exact: true }).filter({ visible: true }).first();
    const locator =
      item.testId || item.role === "tab" || item.role === "menuitem" || (await located.isVisible().catch(() => false))
        ? located
        : button;
    if (!(await locator.isVisible().catch(() => false))) return false;
    if (await isSubmitControl(locator)) return false;
    const href = (await locator.getAttribute("href")) ?? "";
    const live = ((await locator.getAttribute("aria-label")) || (await locator.innerText()) || item.name).replace(/\s+/g, " ").trim();
    if (isForbiddenName(live) || isLogout(href, live)) return false;
    await locator.click({ timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

function isOpenTarget(el: DomObservation): boolean {
  if (!el.visible) return false;
  const name = (el.name ?? "").trim();
  if (!name || isForbiddenName(name) || !OPEN_FORM.test(name)) return false;
  if (el.tag === "button" || el.role === "button" || el.tag === "a" || el.role === "link") return true;
  return el.tag === "input" && (el.inputType ?? "").toLowerCase() === "button";
}

const DESTRUCTIVE_ANYWHERE = /删除|移除|清空|\bdelete\b|\bremove\b|\bclear\b/i;

function isForbiddenName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.includes("确认提交")) return true;
  if (BLOCKED_NAME.test(trimmed)) return true;
  return DESTRUCTIVE_ANYWHERE.test(trimmed);
}

/** A button without an explicit type submits when it sits inside a form. */
async function isSubmitControl(locator: Locator): Promise<boolean> {
  type SubmitControlNode = {
    tagName: string;
    getAttribute(name: string): string | null;
    closest(selector: string): unknown;
  };
  try {
    return await locator.evaluate((node) => {
      const el = node as unknown as SubmitControlNode;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") ?? "").toLowerCase();
      if (tag === "input") return type === "submit" || type === "image";
      if (tag !== "button") return false;
      if (type) return type === "submit";
      return Boolean(el.closest("form"));
    });
  } catch {
    return true;
  }
}

function withOpenedForm(before: DomObservation[], after: DomObservation[]): DomObservation[] {
  const merged = dedupeDom([...before, ...after]);
  const previous = new Set(before.map(domKey));
  const freshFields = after.filter((el) => isField(el) && !previous.has(domKey(el)));
  const structured = merged.some(
    (el) => el.visible && (el.tag === "form" || el.role === "form" || el.role === "dialog" || el.tag === "dialog"),
  );
  if (freshFields.length > 0 && !structured) {
    merged.push({ tag: "form", role: "form", name: "表单", visible: true });
  }
  return merged.slice(0, 300);
}

function isField(el: DomObservation): boolean {
  if (!el.visible) return false;
  if (el.contentEditable || el.tag === "textarea" || el.tag === "select") return true;
  if (el.tag !== "input") return false;
  const inputType = (el.inputType ?? "text").toLowerCase();
  return !["hidden", "button", "submit", "reset", "image"].includes(inputType);
}

function dedupeDom(items: DomObservation[]): DomObservation[] {
  const seen = new Set<string>();
  const out: DomObservation[] = [];
  for (const item of items) {
    const key = domKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function domKey(el: DomObservation): string {
  return [el.tag, el.role ?? "", el.name ?? "", el.testId ?? "", el.inputType ?? "", el.ariaLabel ?? "", String(el.contentEditable === true)].join("|");
}

async function discoverLinks(page: Page): Promise<{ routes: string[]; spa: SpaTarget[] }> {
  const base = page.url();
  const raw = (await page.evaluate(DISCOVER_LINKS)) as Array<{
    href: string;
    name: string;
    testId?: string;
    role?: string;
    download: boolean;
    x?: number;
    width?: number;
    nav?: boolean;
  }>;
  const roleButtons = raw.filter(
    (link) => link.role === "button" && !link.nav && !link.href.trim(),
  );
  const bucketKey = (link: { x?: number; width?: number }): string =>
    `${Math.round((link.x ?? 0) / 24)}:${Math.round((link.width ?? 0) / 24)}`;
  const buckets = new Map<string, number>();
  for (const link of roleButtons) {
    buckets.set(bucketKey(link), (buckets.get(bucketKey(link)) ?? 0) + 1);
  }
  const navBuckets = new Set(
    [...buckets.entries()].filter(([, count]) => count >= 3).map(([key]) => key),
  );
  const routes: string[] = [];
  const spa: SpaTarget[] = [];
  const routePaths = new Set<string>();
  const spaKeys = new Set<string>();
  for (const link of raw) {
    if (isLogout(link.href, link.name) || link.download) continue;
    const kind = linkKind(base, link.href);
    if (kind === "skip") continue;
    if (kind === "spa") {
      if (isForbiddenName(link.name)) continue;
      if (!link.href.trim() && OPEN_FORM.test(link.name)) continue;
      if (link.role === "button" && !link.nav && !link.href.trim()) {
        if ((link.x ?? 999) > 600 || (link.width ?? 0) < 80) continue;
        if (!navBuckets.has(bucketKey(link))) continue;
      }
      if (!link.name && !link.testId) continue;
      const key = link.testId ? `id:${link.testId}` : `${link.role ?? ""}:${link.name}`;
      if (spaKeys.has(key)) continue;
      spaKeys.add(key);
      spa.push({ name: link.name, testId: link.testId, role: link.role });
      continue;
    }
    let absolute: string;
    try {
      absolute = canonicalUrl(new URL(link.href, base).toString());
    } catch {
      continue;
    }
    if (!sameOrigin(base, absolute) || isDownloadPath(absolute)) continue;
    const path = pathOf(absolute);
    if (path === pathOf(base) || routePaths.has(path)) continue;
    routePaths.add(path);
    routes.push(absolute);
  }
  return { routes, spa };
}

function linkKind(base: string, href: string): "spa" | "route" | "skip" {
  const trimmed = href.trim();
  if (!trimmed) return "spa";
  if (trimmed === "#" || trimmed.startsWith("#") || /^javascript:/i.test(trimmed)) return "spa";
  try {
    const url = new URL(trimmed, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "skip";
    if (new URL(base).origin !== url.origin) return "skip";
    return "route";
  } catch {
    return "skip";
  }
}

async function restore(page: Page, url: string, timeout: number): Promise<void> {
  if (samePlace(page.url(), url)) return;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout }).catch(() => undefined);
}

function mergeSignals(signals: Signal[]): Signal[] {
  const map = new Map<SignalId, Signal>();
  for (const signal of signals) {
    const existing = map.get(signal.id);
    if (!existing) {
      map.set(signal.id, { ...signal, evidence: signal.evidence.map((item) => ({ ...item })) });
      continue;
    }
    map.set(signal.id, {
      id: signal.id,
      strength: Math.max(existing.strength, signal.strength),
      evidence: [...existing.evidence, ...signal.evidence],
      detail: existing.detail ?? signal.detail,
    });
  }
  return [...map.values()].map((signal) => ({
    ...signal,
    evidence: signal.evidence.map((item, index) => ({
      ...item,
      id: `route:${item.route ?? ""}#${signal.id}:${index}`,
    })),
  }));
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "/";
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) return parsed.pathname.slice(0, -1);
    return parsed.pathname || "/";
  } catch {
    return "/";
  }
}

function canonicalUrl(url: string): string {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) parsed.pathname = parsed.pathname.slice(0, -1);
  return parsed.toString();
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function samePlace(left: string, right: string): boolean {
  return sameOrigin(left, right) && pathOf(left) === pathOf(right);
}

function isLogout(href: string, name: string): boolean {
  return /logout|signout|sign-out|log-out/i.test(`${href} ${name}`);
}

function isDownloadPath(url: string): boolean {
  try {
    return /\.(?:zip|rar|7z|pdf|csv|xlsx?|docx?|pptx?|png|jpe?g|gif|webp|svg|mp4|mp3|gz|tgz|dmg|pkg)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

async function observeDom(page: Page | Frame): Promise<DomObservation[]> {
  const observed = (await page.evaluate(OBSERVE_DOM)) as DomObservation[];
  return observed.slice(0, 300);
}

async function collectFrames(
  page: Page,
): Promise<{ signals: Signal[]; frames: DetectionEvidence["frames"] }> {
  const signals: Signal[] = [];
  const frames: DetectionEvidence["frames"] = [];
  const main = page.mainFrame();
  for (const frame of page.frames()) {
    if (frame === main) continue;
    await frame
      .waitForFunction("document.body && document.body.innerText.trim().length > 0", {
        timeout: 8_000,
      })
      .catch(() => undefined);
    const dom = await observeDom(frame).catch(() => []);
    const route = pathOf(frame.url());
    signals.push(...classifySignals({ route, dom, network: [] }));
    const text = await readPageText(frame, 4_000);
    if (text) frames.push({ route, text, elements: evidenceElements(dom) });
  }
  return { signals, frames };
}

async function readPageText(page: Page | Frame, limit = 4_000): Promise<string> {
  const text = await page.locator("body").innerText().catch(() => "");
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

function evidenceElements(
  elements: Array<{ role?: string; name?: string; testId?: string; inputType?: string }>,
): Array<{ role?: string; name?: string; testId?: string; inputType?: string }> {
  return elements.map(({ role, name, testId, inputType }) => ({ role, name, testId, inputType }));
}

function endpointsFrom(records: NetworkObservation[]): DetectionEvidence["endpoints"] {
  const seen = new Set<string>();
  const out: DetectionEvidence["endpoints"] = [];
  for (const record of records) {
    const path = pathOf(record.url);
    const key = `${record.method} ${path} ${record.status ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: record.method, path, ...(record.status !== undefined ? { status: record.status } : {}) });
  }
  return out;
}

const OBSERVE_DOM = `(() => {
  if (!document.body) return [];
  const selectors = [
    "table", "[role='grid']", "[role='table']", "[role='dialog']", "dialog", "form", "[role='form']",
    "nav", "[role='navigation']", "aside", "button", "a", "input", "select", "textarea",
    "[contenteditable='true']", "[contenteditable='']", "[role='button']", "[role='link']",
    "[role='menuitem']", "[role='menu']", "[role='log']", "[role='list']", "[role='feed']",
    "[role='status']", "[aria-live='polite']", "th", "[role='columnheader']", "[role='search']",
    "[type='search']", "[aria-label*='消息']", "[aria-label*='聊天']"
  ];
  const seen = new Set();
  const picked = [];
  for (let s = 0; s < selectors.length; s++) {
    const nodes = document.querySelectorAll(selectors[s]);
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (seen.has(el)) continue;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const shown = style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && Number(style.opacity) !== 0 && el.getAttribute("aria-hidden") !== "true" && rect.width > 0 && rect.height > 0;
      if (!shown) continue;
      seen.add(el);
      picked.push(el);
      if (picked.length >= 300) break;
    }
    if (picked.length >= 300) break;
  }
  if (picked.length < 300) {
    const extras = document.body.querySelectorAll("div, p, pre, span, li, section, article, h1, h2, h3, h4");
    const keyword = /工具调用|tool call|调用工具|function call|引用|来源|参考资料|citation|分页|上一页|下一页|页码/;
    for (let i = 0; i < extras.length && picked.length < 300; i++) {
      const el = extras[i];
      if (seen.has(el)) continue;
      const own = (el.innerText || "").trim();
      if (!own || own.length > 80 || !keyword.test(own)) continue;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const shown = style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && el.getAttribute("aria-hidden") !== "true" && rect.width > 0 && rect.height > 0;
      if (!shown) continue;
      seen.add(el);
      picked.push(el);
    }
  }
  const out = [];
  for (let i = 0; i < picked.length && out.length < 300; i++) {
    const el = picked[i];
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "svg" || tag === "path") continue;
    const roleAttr = el.getAttribute("role");
    const ariaLive = el.getAttribute("aria-live");
    const ariaLabel = el.getAttribute("aria-label") || undefined;
    const placeholder = el.getAttribute("placeholder") || undefined;
    const testId = el.getAttribute("data-testid") || undefined;
    const inputType = tag === "input" ? (el.getAttribute("type") || "text") : undefined;
    const editableAttr = el.getAttribute("contenteditable");
    const contentEditable = editableAttr === "" || editableAttr === "true" ? true : undefined;
    const role = roleAttr || (ariaLive === "polite" ? "polite" : undefined);
    let name = ariaLabel || placeholder;
    if (!name && el.labels && el.labels.length > 0 && el.labels[0].textContent) name = el.labels[0].textContent.trim();
    if (!name && tag === "input") {
      const value = el.getAttribute("value");
      if (value && (inputType === "button" || inputType === "submit")) name = value.trim();
    }
    if (!name && tag !== "table" && tag !== "tbody" && tag !== "thead" && tag !== "nav") {
      const text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
      if (text) name = text.slice(0, 80);
    }
    if (name) name = name.replace(/\\s+/g, " ").trim().slice(0, 80);
    const item = { tag: tag, visible: true };
    if (role) item.role = role;
    if (name) item.name = name;
    if (testId) item.testId = testId;
    if (inputType) item.inputType = inputType;
    if (ariaLabel) item.ariaLabel = ariaLabel;
    if (placeholder) item.placeholder = placeholder;
    if (contentEditable) item.contentEditable = true;
    out.push(item);
  }
  return out;
})()`;

const DISCOVER_LINKS = `(() => {
  const nodes = document.querySelectorAll(${JSON.stringify(NAV_SELECTOR)});
  const seen = new Set();
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    if (seen.has(el)) continue;
    seen.add(el);
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const shown = style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none" && Number(style.opacity) !== 0 && el.getAttribute("aria-hidden") !== "true" && el.getAttribute("aria-disabled") !== "true" && rect.width > 0 && rect.height > 0;
    if (!shown) continue;
    const href = el.getAttribute("href") || "";
    const aria = el.getAttribute("aria-label");
    const text = (el.innerText || "").replace(/\\s+/g, " ").trim();
    const name = (aria || text).slice(0, 80);
    const testId = el.getAttribute("data-testid") || undefined;
    const role = el.getAttribute("role") || (el.tagName.toLowerCase() === "button" ? "button" : undefined);
    const inNav = Boolean(el.closest("nav, [role='navigation'], aside, [role='complementary'], [class*='sidebar'], [class*='sider']"));
    const item = { href: href, name: name, download: el.hasAttribute("download"), x: Math.round(rect.x), width: Math.round(rect.width), nav: inNav };
    if (testId) item.testId = testId;
    if (role) item.role = role;
    out.push(item);
  }
  return out;
})()`;

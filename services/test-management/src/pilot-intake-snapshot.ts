import type { FormFieldHint, FormHint, PageContext } from "@testpilot/planner";
import { snapshotPageContext } from "@testpilot/context-web";
import { chromium, type Locator, type Page } from "playwright";
import { pilotSecretsConfigured } from "./run-env.js";

const OPTIONAL_FIELD = /可选|optional|服务人员|社区/;
const SECRET_FIELD = /密码|password|验证码|token/i;

export function normalizePilotBase(base: string): string {
  return base.replace(/\/$/, "");
}

/** True when URL origin matches configured pilot base. */
export function isPilotIntakeUrl(url: string, pilotBase: string): boolean {
  if (!pilotBase.trim()) return false;
  try {
    const target = new URL(url);
    const base = new URL(normalizePilotBase(pilotBase));
    return target.origin === base.origin;
  } catch {
    return false;
  }
}

export function resolvePilotTargetPath(url: string, pilotBase: string): string {
  const baseNorm = normalizePilotBase(pilotBase);
  const baseUrl = new URL(baseNorm);
  const target = new URL(url);
  if (target.origin !== baseUrl.origin) return target.pathname + target.search;
  const basePath = baseUrl.pathname.replace(/\/$/, "") || "";
  let path = target.pathname;
  if (basePath && path.startsWith(basePath)) {
    path = path.slice(basePath.length) || "/";
  }
  if (!path.startsWith("/")) path = `/${path}`;
  return path + target.search;
}

export function resolveLoginUrl(pilotBase: string, loginPath = "/admin/login"): string {
  const baseNorm = normalizePilotBase(pilotBase);
  const path = loginPath.trim() || "/admin/login";
  if (/^https?:\/\//i.test(path)) return path;
  return `${baseNorm}${path.startsWith("/") ? path : `/${path}`}`;
}

export function looksLikeLoginPageContext(context: PageContext): boolean {
  if (/\/login|\/signin|\/sign-in/i.test(context.url)) return true;
  const names = context.elements.map((e) => e.name ?? "").join(" ").toLowerCase();
  const hasCredentialFields = /密码|password|手机号|phone|邮箱|email/i.test(names);
  const hasAppShell = /选择服务项目|提交工单|客户|dashboard|退出登录|工单/.test(names);
  return hasCredentialFields && !hasAppShell;
}

export type CapturePilotIntakeOptions = {
  /** When intent mentions 工单, try opening ticket form before snapshot. */
  intentText?: string;
  /** Login page path from pilot-baseline.json; defaults to /admin/login. */
  loginPath?: string;
};

type RawField = {
  label: string;
  kind: "text" | "textarea" | "combobox";
  value: string;
  selectedText: string;
};

async function collectVisibleFields(scope: Locator): Promise<RawField[]> {
  // Keep the callback free of named inner functions: tsx's __name helper would
  // otherwise be serialized into the page and throw a ReferenceError there.
  return scope.evaluate((rootEl: any) => {
    const list: RawField[] = [];
    rootEl.querySelectorAll("input, textarea").forEach((el: any) => {
      const style = (globalThis as any).getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "file" || type === "radio" || type === "checkbox" || type === "hidden") return;
      const label =
        (el.labels?.[0]?.textContent?.trim()) ||
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        "";
      if (!label) return;
      const tag = el.tagName.toLowerCase();
      const wrapper = el.closest(".el-select");
      const selectedText = wrapper
        ? ((wrapper.querySelector(".el-select__selected-item")?.textContent || "").trim())
        : "";
      const kind: RawField["kind"] =
        el.getAttribute("role") === "combobox" || wrapper
          ? "combobox"
          : tag === "textarea"
            ? "textarea"
            : "text";
      list.push({ label, kind, value: el.value || "", selectedText });
    });
    return list;
  });
}

/**
 * Open dropdowns inside the ticket dialog and record a replayable option chain.
 * The capture browser is throwaway, so choosing an address here has no side effect;
 * it tells the planner which labels and options to replay in the real run.
 */
async function exploreVisibleForm(page: Page): Promise<FormHint | undefined> {
  const dialogs = page.locator('[role="dialog"]:visible');
  const dialogCount = await dialogs.count().catch(() => 0);
  let scope = page.locator("body");
  let title: string | undefined;
  if (dialogCount > 0) {
    scope = dialogs.last();
    title =
      (await scope.getAttribute("aria-label").catch(() => null)) ??
      (await scope
        .locator('[role="heading"]')
        .first()
        .innerText()
        .then((t) => t.trim())
        .catch(() => "")) ??
      undefined;
  }

  const raw = await collectVisibleFields(scope).catch(() => [] as RawField[]);
  if (!raw.length) return undefined;

  const fields: FormFieldHint[] = [];
  for (const field of raw) {
    if (SECRET_FIELD.test(field.label)) continue;
    if (OPTIONAL_FIELD.test(field.label)) continue;
    if (field.kind !== "combobox") {
      fields.push({ label: field.label, kind: field.kind, value: field.value });
      continue;
    }
    if (field.selectedText) {
      fields.push({ label: field.label, kind: "combobox", selectedText: field.selectedText });
      continue;
    }
    const combo = scope.getByLabel(field.label, { exact: true }).first();
    let clicked = false;
    try {
      await combo.click({ timeout: 4_000 });
      clicked = true;
    } catch {
      clicked = false;
    }
    if (!clicked) continue;
    await page.waitForTimeout(400);
    const options = page.locator('.el-select-dropdown:visible li[role="option"], [role="listbox"]:visible [role="option"]');
    const optionCount = await options.count().catch(() => 0);
    if (optionCount === 0) {
      await page.keyboard.press("Escape").catch(() => undefined);
      continue;
    }
    const option = (await options.first().innerText().catch(() => "")).trim();
    if (!option) {
      await page.keyboard.press("Escape").catch(() => undefined);
      continue;
    }
    await options.first().click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    fields.push({ label: field.label, kind: "combobox", option });
  }

  const submit = scope
    .getByRole("button", { name: /^(确认提交|提交|保存|确定|创建)$/ })
    .first();
  const submitLabel = (await submit.isVisible().catch(() => false))
    ? (await submit.innerText().catch(() => "")).trim()
    : undefined;

  return {
    scope: dialogCount > 0 ? "dialog" : "page",
    ...(title ? { title } : {}),
    ...(submitLabel ? { submitLabel } : {}),
    fields,
  };
}

/**
 * Log into pilot admin, navigate to target path, optionally open ticket UI, then snapshot.
 */
export async function capturePilotIntakeContext(
  pilotBase: string,
  targetUrl: string,
  opts?: CapturePilotIntakeOptions,
): Promise<PageContext> {
  if (!pilotSecretsConfigured()) {
    throw new Error("试点 intake 需要 TESTPILOT_ENV_ADMIN_PHONE 与 TESTPILOT_ENV_ADMIN_PASSWORD");
  }

  const baseNorm = normalizePilotBase(pilotBase);
  const targetPath = resolvePilotTargetPath(targetUrl, pilotBase);
  const phone = process.env.TESTPILOT_ENV_ADMIN_PHONE!.trim();
  const password = process.env.TESTPILOT_ENV_ADMIN_PASSWORD!.trim();
  const loginPath = opts?.loginPath?.trim() || "/admin/login";
  const loginUrl = resolveLoginUrl(baseNorm, loginPath);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page
      .waitForFunction("document.body && document.body.innerText.trim().length > 0", { timeout: 20_000 })
      .catch(() => undefined);

    const passwordTab = page.getByRole("tab", { name: /密码|password/i });
    if (await passwordTab.isVisible().catch(() => false)) {
      await passwordTab.click();
    }

    const phoneField = page
      .getByLabel(/手机号|手机|phone/i)
      .or(page.locator('input[type="tel"]'))
      .first();
    const passwordField = page
      .getByPlaceholder(/密码|password/i)
      .or(page.locator('input[type="password"]'))
      .first();
    const loginButton = page.getByRole("button", { name: /登录|sign ?in|login/i }).first();
    if (!(await phoneField.isVisible().catch(() => false)) || !(await loginButton.isVisible().catch(() => false))) {
      throw new Error(
        `登录表单未找到（loginPath=${loginPath}）；请在 pilot-baseline.json 配置正确路径，或检查页面选择器`,
      );
    }
    await phoneField.fill(phone);
    await passwordField.fill(password);
    await loginButton.click();
    await page.waitForLoadState("domcontentloaded");
    await page
      .waitForURL((u) => !/\/login|\/signin|\/sign-in/i.test(u.pathname), { timeout: 20_000 })
      .catch(() => undefined);
    // The shell becomes usable before the route settles; jumping to /customer too
    // early used to land on the tenant picker (/select) instead.
    await page
      .getByText("我的工单")
      .first()
      .waitFor({ state: "visible", timeout: 20_000 })
      .catch(() => undefined);

    const destination = `${baseNorm}${targetPath.startsWith("/") ? targetPath : `/${targetPath}`}`;
    await page.goto(destination, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1_200);
    if (/\/select\/?$/.test(page.url())) {
      await page.goto(destination, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(1_200);
    }

    const intent = opts?.intentText ?? "";
    let form: FormHint | undefined;
    if (/工单|ticket/.test(intent)) {
      let openTarget: FormHint["openTarget"];
      const openByTestId = page.getByTestId("open-ticket").first();
      const openByRole = page.getByRole("button", { name: "提交工单", exact: true }).first();
      if (await openByTestId.isVisible().catch(() => false)) {
        await openByTestId.click();
        openTarget = { testId: "open-ticket" };
      } else if (await openByRole.isVisible().catch(() => false)) {
        await openByRole.click();
        openTarget = { role: "button", name: "提交工单" };
      }
      await page.waitForTimeout(800);
      await page
        .locator('[role="dialog"]:visible')
        .first()
        .waitFor({ state: "visible", timeout: 6_000 })
        .catch(() => undefined);
      form = await exploreVisibleForm(page);
      if (form && openTarget) form = { ...form, openTarget };
    }

    const context = await snapshotPageContext(page);
    if (looksLikeLoginPageContext(context)) {
      throw new Error("登录后快照仍是登录页，请检查凭据或目标 URL");
    }
    return form ? { ...context, form } : context;
  } finally {
    await browser.close();
  }
}

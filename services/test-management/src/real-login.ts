import { chromium, type Browser, type Page } from "playwright";
import { realBaseUrl } from "./run-env.js";
import { realLoginProfileFromEnv, type RealLoginProfile } from "./real-login-profile.js";

export type RealPageHandle = { browser: Browser; page: Page };

export type RealAccount = "primary" | "alt";

const REAL_ACCOUNT_ENV: Record<RealAccount, { enterprise: string; user: string; password: string }> = {
  primary: {
    enterprise: "TESTPILOT_ENV_REAL_ENTERPRISE_ID",
    user: "TESTPILOT_ENV_REAL_USER_ID",
    password: "TESTPILOT_ENV_REAL_PASSWORD",
  },
  alt: {
    enterprise: "TESTPILOT_ENV_REAL_ALT_ENTERPRISE_ID",
    user: "TESTPILOT_ENV_REAL_ALT_USER_ID",
    password: "TESTPILOT_ENV_REAL_ALT_PASSWORD",
  },
};

function sameOriginAs(url: string, configured: string): boolean {
  if (!configured.trim()) return false;
  try {
    return new URL(url).origin === new URL(configured).origin;
  } catch {
    return false;
  }
}

export function isRealTarget(baseUrl: string): boolean {
  if (!baseUrl.trim()) return false;
  return sameOriginAs(baseUrl, realBaseUrl());
}

export function realLoginConfig(
  account: RealAccount = "primary",
): { enterpriseId: string; userId: string; password: string } | null {
  const keys = REAL_ACCOUNT_ENV[account];
  const enterpriseId = process.env[keys.enterprise]?.trim();
  const userId = process.env[keys.user]?.trim();
  const password = process.env[keys.password]?.trim();
  if (!enterpriseId || !userId || !password) return null;
  return { enterpriseId, userId, password };
}

function configuredRealSecrets(): string[] {
  return Object.values(REAL_ACCOUNT_ENV)
    .flatMap((keys) => [process.env[keys.enterprise], process.env[keys.user], process.env[keys.password]])
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
}

function redactCredentialHints(text: string): string {
  let out = text;
  for (const secret of configuredRealSecrets()) {
    if (secret.length >= 2) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

function formatLoginPageExcerpt(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  const excerpt = redactCredentialHints(normalized).slice(0, 200);
  return excerpt || "页面未返回可读文本";
}

/**
 * Enterprise account login for the configured real environment. Credentials are
 * read from TESTPILOT_ENV_REAL_* (or TESTPILOT_ENV_REAL_ALT_* for the alt account)
 * only; they are not logged or written to artifacts.
 */
export async function loginRealPage(
  page: Page,
  baseUrl: string,
  account: RealAccount = "primary",
): Promise<void> {
  const config = realLoginConfig(account);
  if (!config) {
    const keys = REAL_ACCOUNT_ENV[account];
    throw new Error(
      `真实环境需要 ${keys.enterprise} / ${keys.user} / ${keys.password}`,
    );
  }
  const { enterpriseId, userId, password } = config;

  const profile = realLoginProfileFromEnv();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2_500);

  const state = await waitForLoginOrApp(page, profile);
  if (state === "timeout") {
    throw new Error("真实环境登录页未出现（可能需要配置 TESTPILOT_REAL_LOGIN_PROFILE_JSON）");
  }
  if (state === "login") {
    const fields = await waitForLoginForm(page, profile);
    if (profile.tenantField) {
      const tenant = await firstVisible(page, [profile.tenantField]);
      if (tenant) await tenant.fill(enterpriseId);
    }
    const user = profile.userField
      ? await firstVisible(page, [profile.userField])
      : await genericUserField(page);
    if (!user) throw new Error("真实环境登录页未找到账号输入框");
    await user.fill(userId);
    await fields.password.fill(password);
    await page.waitForTimeout(800);
    if (profile.consentSelector) {
      await firstVisible(page, [profile.consentSelector]).then((locator) => locator?.click().catch(() => undefined));
    } else {
      await checkConsent(page);
    }

    if (!(await clickLogin(page, profile))) {
      throw new Error("真实环境登录按钮不可用");
    }
    try {
      await waitForLoginSuccess(page);
    } catch {
      const body = await page.locator("body").innerText().catch(() => "");
      throw new Error(`真实环境登录未完成：${formatLoginPageExcerpt(body)}`);
    }
    await page.waitForTimeout(1_500);
  }
}

async function firstVisible(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = Math.min(await locator.count().catch(() => 0), 5);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return undefined;
}

/** OAuth redirects can take seconds; wait for either the login form or the app itself. */
async function waitForLoginOrApp(page: Page, profile: RealLoginProfile): Promise<"login" | "app" | "timeout"> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const path = (() => {
      try {
        return new URL(page.url()).pathname;
      } catch {
        return "";
      }
    })();
    if (profile.enterpriseTabText && /login/i.test(path)) {
      await switchToLoginTab(page, profile.enterpriseTabText);
    }
    if (await firstVisible(page, [profile.passwordField ?? 'input[type="password"]'])) return "login";
    if (path && !/\/login|\/oauth|\/auth\//i.test(path)) return "app";
    await page.waitForTimeout(1_000);
  }
  return "timeout";
}

async function genericUserField(page: Page) {
  return firstVisible(page, [
    'input[type="text"]',
    'input[type="tel"]',
    'input[type="email"]',
    'input:not([type="password"])',
  ]);
}

/** Click an optional login-mode tab, then wait for the password field. */
async function waitForLoginForm(page: Page, profile: RealLoginProfile) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const visible = await firstVisible(page, [profile.passwordField ?? 'input[type="password"]']);
    if (visible) return { password: visible };
    if (profile.enterpriseTabText) await switchToLoginTab(page, profile.enterpriseTabText);
    await page.waitForTimeout(900);
  }
  const password = await firstVisible(page, [profile.passwordField ?? 'input[type="password"]']);
  if (!password) throw new Error("真实环境登录页未找到密码输入框");
  return { password };
}

async function waitForLoginSuccess(page: Page): Promise<void> {
  await page
    .waitForFunction(
      `(() => {
        const pw = document.querySelector('input[type="password"]');
        if (!pw) return true;
        const rect = pw.getBoundingClientRect();
        return rect.width === 0 || rect.height === 0;
      })()`,
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => {
      throw new Error("still on login form");
    });
}

/**
 * Launch a browser and log into the real environment. The caller owns the browser.
 */
export async function openRealPage(baseUrl: string): Promise<RealPageHandle> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    await loginRealPage(page, baseUrl);
    return { browser, page };
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err;
  }
}

async function switchToLoginTab(page: Page, text: string): Promise<void> {
  await page.evaluate((tabText) => {
    const doc = (globalThis as any).document;
    const candidates = [...doc.querySelectorAll("button,[role=tab],a,li,div,span")].filter(
      (item: any) => {
        const content = (item.textContent || "").trim();
        if (!content.includes(tabText)) return false;
        const rect = item.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      },
    );
    const target = candidates[candidates.length - 1];
    if (!target) return;
    const clickable = target.closest("button,[role=tab],a,[role=button]") || target;
    clickable.click();
  }, text);
  await page.waitForTimeout(800);
}

async function checkConsent(page: Page): Promise<void> {
  const unchecked = page
    .locator('button[role="checkbox"][aria-checked="false"]')
    .filter({ visible: true })
    .first();
  if (await unchecked.isVisible().catch(() => false)) {
    await unchecked.click({ timeout: 2_000 }).catch(() => undefined);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function clickLogin(page: Page, profile: RealLoginProfile): Promise<boolean> {
  const name = profile.submitText ? new RegExp(`^${escapeRegExp(profile.submitText)}$`) : /登录|login|sign\s?in/i;
  const button = page.getByRole("button", { name }).filter({ visible: true }).first();
  if (await button.isVisible().catch(() => false)) {
    await button.click({ timeout: 2_000 }).catch(() => undefined);
    return true;
  }
  return page.evaluate(() => {
    const doc = (globalThis as any).document;
    const controls = [...doc.querySelectorAll("button,input[type=submit]")].filter(
      (item: any) => item.getBoundingClientRect().width > 0 && item.getBoundingClientRect().height > 0 && !item.disabled,
    );
    const fallback = controls.find((item: any) => /登录|login|sign\s?in/i.test(item.textContent || item.value || ""));
    const target = fallback ?? controls[0];
    if (!target) return false;
    target.click();
    return true;
  });
}

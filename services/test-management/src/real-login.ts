import { chromium, type Browser, type Page } from "playwright";
import { realSecretsConfigured } from "./run-env.js";

export type RealPageHandle = { browser: Browser; page: Page };

/**
 * Enterprise account login for the configured real environment. The caller owns
 * the browser; no credentials are logged or persisted outside .env.
 */
export async function openRealPage(baseUrl: string): Promise<RealPageHandle> {
  if (!realSecretsConfigured()) {
    throw new Error(
      "真实环境需要 TESTPILOT_ENV_REAL_ENTERPRISE_ID / TESTPILOT_ENV_REAL_USER_ID / TESTPILOT_ENV_REAL_PASSWORD",
    );
  }
  const enterpriseId = process.env.TESTPILOT_ENV_REAL_ENTERPRISE_ID!.trim();
  const userId = process.env.TESTPILOT_ENV_REAL_USER_ID!.trim();
  const password = process.env.TESTPILOT_ENV_REAL_PASSWORD!.trim();

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(2_500);

    if (/\/login/i.test(new URL(page.url()).pathname)) {
      await switchToEnterpriseLogin(page);
      const tenant = page.locator('input[name="tenantCode"]');
      await tenant.waitFor({ state: "visible", timeout: 10_000 });
      await tenant.fill(enterpriseId);
      await page.locator('input[name="userCode"]').fill(userId);
      await page.locator('input[name="password"]').fill(password);
      await page.waitForTimeout(800);
      await checkConsent(page);

      if (!(await clickLogin(page))) {
        throw new Error("真实环境登录按钮不可用（请检查企业账号表单）");
      }
      try {
        await page.waitForURL((url) => !/\/login/i.test(url.pathname), { timeout: 30_000 });
      } catch {
        const body = await page.locator("body").innerText().catch(() => "");
        throw new Error(`真实环境登录失败：${body.replace(/\s+/g, " ").slice(0, 200)}`);
      }
      await page.waitForTimeout(1_500);
    }

    return { browser, page };
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err;
  }
}

async function switchToEnterpriseLogin(page: Page): Promise<void> {
  await page.evaluate(() => {
    const doc = (globalThis as any).document;
    const button = [...doc.querySelectorAll("button")].find(
      (item: any) => (item.textContent || "").trim() === "企业账号登录",
    );
    if (button) button.click();
  });
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

async function clickLogin(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = (globalThis as any).document;
    const buttons = [...doc.querySelectorAll("button")].filter(
      (item: any) => item.type === "submit" && (item.textContent || "").trim() === "登录",
    );
    const visible = buttons.find((item: any) => {
      const rect = item.getBoundingClientRect();
      const style = (globalThis as any).getComputedStyle(item);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        !item.disabled
      );
    });
    if (visible) {
      visible.click();
      return true;
    }
    return false;
  });
}

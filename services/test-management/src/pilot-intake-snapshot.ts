import type { PageContext } from "@testpilot/planner";
import { snapshotPageContext } from "@testpilot/context-web";
import { chromium } from "playwright";
import { pilotSecretsConfigured } from "./run-env.js";

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

export function looksLikeLoginPageContext(context: PageContext): boolean {
  if (context.url.includes("/admin/login")) return true;
  const names = context.elements.map((e) => e.name ?? "").join(" ");
  const hasLoginCta = /登录/.test(names);
  const hasCredentialFields = /密码|手机号|请输入密码/.test(names);
  const hasAppShell = /选择服务项目|提交工单|客户/.test(names);
  return hasLoginCta && hasCredentialFields && !hasAppShell;
}

export type CapturePilotIntakeOptions = {
  /** When intent mentions 工单, try opening ticket form before snapshot. */
  intentText?: string;
};

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

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${baseNorm}/admin/login`, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await page
      .waitForFunction("document.body && document.body.innerText.trim().length > 0", { timeout: 20_000 })
      .catch(() => undefined);

    const passwordTab = page.getByRole("tab", { name: "密码" });
    if (await passwordTab.isVisible().catch(() => false)) {
      await passwordTab.click();
    }

    await page.getByLabel("手机号").fill(phone);
    await page.getByPlaceholder("请输入密码").fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForLoadState("domcontentloaded");

    const destination = `${baseNorm}${targetPath.startsWith("/") ? targetPath : `/${targetPath}`}`;
    await page.goto(destination, { waitUntil: "domcontentloaded", timeout: 25_000 });

    const intent = opts?.intentText ?? "";
    if (/工单|ticket/.test(intent)) {
      const openByTestId = page.getByTestId("open-ticket");
      const openByRole = page.getByRole("button", { name: "提交工单", exact: true });
      if (await openByTestId.isVisible().catch(() => false)) {
        await openByTestId.click();
      } else if (await openByRole.isVisible().catch(() => false)) {
        await openByRole.click();
      }
      await page.waitForTimeout(800);
    }

    const context = await snapshotPageContext(page);
    if (looksLikeLoginPageContext(context)) {
      throw new Error("登录后快照仍是登录页，请检查凭据或目标 URL");
    }
    return context;
  } finally {
    await browser.close();
  }
}

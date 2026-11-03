import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotPageContext } from "@testpilot/context-web";
import { draftToPartialIR, planFromIntake } from "@testpilot/planner";
import { applyOptionalLlmDraft } from "./llm-planner.js";
import { assertPlaywrightReady } from "@testpilot/recorder-web";
import { validateTestIR, type TestStep } from "@testpilot/test-ir";
import { chromium } from "playwright";
import type { FastifyBaseLogger } from "fastify";
import type { FileStore } from "./store.js";
import { pilotBaseUrl, pilotSecretsConfigured } from "./run-env.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const presetsPath = join(dirname(fileURLToPath(import.meta.url)), "pilot-intake-presets.json");
const loginIrPath = join(repoRoot, "examples/pilot-admin/tests/pilot-admin-password-login.json");

type Preset = {
  id: string;
  title: string;
  intent: string;
  pathAfterLogin?: string;
  refreshDraft?: boolean;
};

async function loadPilotConstraints(): Promise<{ scopeNotes: string[] } | null> {
  for (const name of ["pilot-constraints.json", "pilot-constraints.example.json"]) {
    try {
      const raw = await readFile(join(repoRoot, "docs", name), "utf8");
      return JSON.parse(raw) as { scopeNotes: string[] };
    } catch {
      /* next */
    }
  }
  return null;
}

async function pilotLoginSteps(): Promise<TestStep[]> {
  const raw = await readFile(loginIrPath, "utf8");
  const ir = JSON.parse(raw) as { steps: TestStep[] };
  return ir.steps.filter((s) => s.action !== "wait" || s.id === "wait-dashboard");
}

async function capturePlanningContext(base: string, pathAfterLogin: string, intent: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const baseNorm = base.replace(/\/$/, "");
    await page.goto(`${baseNorm}/admin/login`, { waitUntil: "domcontentloaded", timeout: 25_000 });

    const phone = process.env.TESTPILOT_ENV_ADMIN_PHONE?.trim();
    const password = process.env.TESTPILOT_ENV_ADMIN_PASSWORD?.trim();
    if (!phone || !password) throw new Error("missing pilot credentials");

    await page.getByLabel("手机号").fill(phone);
    await page.getByLabel("密码").fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForLoadState("domcontentloaded");

    const targetUrl = `${baseNorm}${pathAfterLogin.startsWith("/") ? pathAfterLogin : `/${pathAfterLogin}`}`;
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 25_000 });

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

    return await snapshotPageContext(page);
  } finally {
    await browser.close();
  }
}

export async function bootstrapPilotIntakes(store: FileStore, log: FastifyBaseLogger): Promise<number> {
  const base = pilotBaseUrl();
  if (!base || !pilotSecretsConfigured()) return 0;

  let presets: Preset[];
  try {
    presets = JSON.parse(await readFile(presetsPath, "utf8")) as Preset[];
  } catch {
    return 0;
  }

  const constraints = await loadPilotConstraints();
  let saved = 0;

  try {
    await assertPlaywrightReady();
  } catch (err) {
    log.warn({ err }, "Pilot auto-intake skipped: Playwright not ready");
    return 0;
  }

  for (const preset of presets) {
    const existing = await store.getTest(preset.id);
    if (existing?.approvalStatus === "approved") continue;
    if (existing && !preset.refreshDraft) continue;

    try {
      const context = await capturePlanningContext(base, preset.pathAfterLogin ?? "/customer", preset.intent);
      const constraintLine = constraints?.scopeNotes?.[0];
      const text = [preset.intent, constraintLine].filter(Boolean).join("\n");
      const ruleDraft = planFromIntake({
        title: preset.title,
        channel: "intent",
        text,
        context,
        constraints: constraints?.scopeNotes,
      });

      const { draft: enrichedDraft } = await applyOptionalLlmDraft({
        goal: text,
        context,
        ruleDraft,
      });

      const loginSteps = await pilotLoginSteps();
      const mergedSteps: TestStep[] = [
        ...loginSteps.map((s) => ({ ...s, id: `login-${s.id}` })),
        ...enrichedDraft.steps.filter((s) => s.id !== "open-target"),
      ];

      const draft = { ...enrichedDraft, steps: mergedSteps };
      const partial = draftToPartialIR(preset.id, draft);
      const ir = {
        ...partial,
        baseUrlRef: "pilot-admin",
        policy: { screenshots: "on-failure" as const, retry: { attempts: 1, on: ["ENVIRONMENT"] } },
      };
      const validated = validateTestIR(ir);
      if (!validated.ok) {
        log.warn({ preset: preset.id, issues: validated.issues }, "Pilot auto-intake IR invalid");
        continue;
      }

      await store.saveTest({
        id: preset.id,
        projectId: "default",
        title: preset.title,
        ir: validated.value,
        approvalStatus: "draft",
        intentSummary: preset.intent,
        sourceChannel: "intent",
        plannerNotes: draft.uncertainties,
        updatedAt: new Date().toISOString(),
      });
      saved += 1;
      log.info(`Auto-intake saved draft: ${preset.id}`);
    } catch (err) {
      log.warn({ err, preset: preset.id }, "Pilot auto-intake failed for preset");
    }
  }

  return saved;
}

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { draftToPartialIR, planFromIntake } from "@testpilot/planner";
import { applyOptionalLlmDraft } from "./llm-planner.js";
import { assertPlaywrightReady } from "@testpilot/recorder-web";
import { computeIRHash, IR_HASH_VERSION, validateTestIR, type TestStep } from "@testpilot/test-ir";
import type { FastifyBaseLogger } from "fastify";
import type { FileStore } from "./store.js";
import { pilotBaseUrl, pilotSecretsConfigured } from "./run-env.js";
import { capturePilotIntakeContext } from "./pilot-intake-snapshot.js";

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

function pilotScopeSteps(preset: Preset): TestStep[] {
  const path = preset.pathAfterLogin ?? "/customer";
  const goto: TestStep = { id: "goto-scope", action: "navigate", path };
  if (preset.id.includes("ticket")) {
    return [
      goto,
      { id: "open-ticket", action: "click", target: { role: "button", name: "提交工单" } },
      {
        id: "fill-phone",
        action: "fill",
        target: { label: "联系电话" },
        value: "19900000001",
      },
      {
        id: "fill-address",
        action: "fill",
        target: { label: "详细地址" },
        value: "TestPilot-{{runId}}",
      },
      {
        id: "fill-detail",
        action: "fill",
        target: { label: "需求说明" },
        value: "自动回归 {{runId}}",
      },
      { id: "confirm-submit", action: "click", target: { role: "button", name: "确认提交" } },
    ];
  }
  return [goto, { id: "wait-customer", action: "wait", target: { name: "选择服务项目" } }];
}

function pilotScopeAssertions(preset: Preset) {
  if (preset.id.includes("ticket")) {
    return [
      {
        id: "ticket-required-fields",
        type: "ui" as const,
        target: { role: "alert" },
        contains: "请选择省、市、区县和街道",
        oracle: "human-approved" as const,
      },
    ];
  }
  return [
    {
      id: "customer-loaded",
      type: "ui" as const,
      contains: "选择服务项目",
      oracle: "human-approved" as const,
    },
  ];
}

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

export async function pilotLoginSteps(): Promise<TestStep[]> {
  const raw = await readFile(loginIrPath, "utf8");
  const ir = JSON.parse(raw) as { steps: TestStep[] };
  return ir.steps.filter((s) => s.action !== "wait" || s.id === "wait-dashboard");
}

async function loadLoginPath(): Promise<string | undefined> {
  for (const name of ["pilot-baseline.json", "pilot-baseline.example.json"]) {
    try {
      const raw = await readFile(join(repoRoot, "docs", name), "utf8");
      const doc = JSON.parse(raw) as { loginPath?: string };
      if (doc.loginPath?.trim()) return doc.loginPath.trim();
    } catch {
      /* next */
    }
  }
  return undefined;
}

async function capturePlanningContext(base: string, pathAfterLogin: string, intent: string, loginPath?: string) {
  const baseNorm = base.replace(/\/$/, "");
  const targetUrl = `${baseNorm}${pathAfterLogin.startsWith("/") ? pathAfterLogin : `/${pathAfterLogin}`}`;
  return capturePilotIntakeContext(base, targetUrl, { intentText: intent, loginPath });
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
  const loginPath = await loadLoginPath();
  let saved = 0;

  try {
    await assertPlaywrightReady();
  } catch (err) {
    log.warn({ err }, "Pilot auto-intake skipped: Playwright not ready");
    return 0;
  }

  for (const preset of presets) {
    const existing = await store.getTest(preset.id);
    if (existing?.approvalStatus === "approved" && existing.approvedAt && !preset.refreshDraft) continue;
    if (existing && !preset.refreshDraft) continue;

    try {
      const context = await capturePlanningContext(base, preset.pathAfterLogin ?? "/customer", preset.intent, loginPath);
      const constraintLine = constraints?.scopeNotes?.[0];
      const text = [preset.intent, constraintLine].filter(Boolean).join("\n");
      const ruleDraft = planFromIntake({
        title: preset.title,
        channel: "intent",
        text,
        context,
        constraints: constraints?.scopeNotes,
      });

      const enrichedDraft = preset.refreshDraft
        ? ruleDraft
        : (
            await applyOptionalLlmDraft({
              goal: text,
              context,
              ruleDraft,
            })
          ).draft;

      const loginSteps = await pilotLoginSteps();
      const scopeSteps = pilotScopeSteps(preset);
      const mergedSteps: TestStep[] = [
        ...loginSteps.map((s) => ({ ...s, id: `login-${s.id}` })),
        ...scopeSteps,
        ...enrichedDraft.steps.filter(
          (s) => s.id !== "open-target" && s.action !== "navigate" && !loginSteps.some((l) => l.id === s.id),
        ),
      ];

      const draft = {
        ...enrichedDraft,
        steps: mergedSteps,
        assertions: pilotScopeAssertions(preset),
      };
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
        irHash: computeIRHash(validated.value),
        irHashVersion: IR_HASH_VERSION,
        // Regenerated IR must be reviewed again; never keep an old approval.
        approvalStatus: "draft",
        approvedAt: undefined,
        approvedBy: undefined,
        assertionConfigHash: undefined,
        intentSummary: preset.intent,
        sourceChannel: "intent",
        plannerNotes: draft.uncertainties,
        updatedAt: new Date().toISOString(),
      });
      if (existing?.approvalStatus === "approved") {
        log.warn({ preset: preset.id }, "Refreshed pilot draft was demoted from approved; review required");
      }
      saved += 1;
      log.info(`Auto-intake saved draft: ${preset.id}`);
    } catch (err) {
      log.warn({ err, preset: preset.id }, "Pilot auto-intake failed for preset");
    }
  }

  return saved;
}

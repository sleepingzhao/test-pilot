import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { collectSystemProfile, type SystemProfile } from "@testpilot/detect";
import { redactStringBody } from "@testpilot/evidence";
import { chromium, type Page } from "playwright";
import { openPilotPage } from "./pilot-intake-snapshot.js";
import { openRealPage } from "./real-login.js";
import {
  analyzeCapabilitiesWithLlm,
  mergeLlmAnalysis,
  type LlmDetectionResult,
} from "./llm-detect.js";
import { resolveRequirementTargetUrl, type RequirementTarget } from "./requirement-target.js";
import { pilotSecretsConfigured } from "./run-env.js";
import { isAllowedTargetUrl, isSafeRunId } from "./security.js";
import {
  sessionDir,
  sessionIdForDetect,
  sessionMetaPath,
  sessionProfilePath,
  sessionsRoot,
  type SessionMeta,
} from "./session-layout.js";

export type DetectionTarget = RequirementTarget;

export type DetectionRecord = {
  id: string;
  sessionId: string;
  target: DetectionTarget;
  url: string;
  createdAt: string;
  profile: SystemProfile;
};

export type DetectionJob = {
  id: string;
  status: "running" | "completed" | "failed";
  stage: string;
  startedAt: string;
  completedAt?: string;
  result?: DetectionRecord;
  error?: string;
};

export type RunDetectionInput = {
  dataRoot: string;
  target: DetectionTarget;
  customUrl?: string;
  demoUrl: string;
  pilotUrl?: string;
  pilotIntakeUrl?: string;
  realUrl?: string;
  loginPath?: string;
};

type OpenPageInput = {
  target: DetectionTarget;
  url: string;
  pilotUrl?: string;
  realUrl?: string;
  loginPath?: string;
};

export type DetectionDeps = {
  openPage?: (input: OpenPageInput) => Promise<{ page: Page; close: () => Promise<void> }>;
  collect?: (page: Page) => Promise<SystemProfile>;
  analyze?: (profile: SystemProfile) => Promise<LlmDetectionResult>;
};

export async function runDetection(
  input: RunDetectionInput,
  onStage: (stage: string) => void,
  deps: DetectionDeps = {},
): Promise<DetectionRecord> {
  onStage("校验目标环境");
  const resolved = resolveRequirementTargetUrl({
    target: input.target,
    customUrl: input.customUrl,
    demoUrl: input.demoUrl,
    pilotUrl: input.pilotUrl,
    pilotIntakeUrl: input.pilotIntakeUrl,
    realUrl: input.realUrl,
  });
  if (!resolved.ok) throw new Error(resolved.error);
  if (!isAllowedTargetUrl(resolved.url)) throw new Error("目标 URL 不在允许列表");
  if (input.target === "pilot" && !pilotSecretsConfigured()) {
    throw new Error("试点探测需要 TESTPILOT_ENV_ADMIN_PHONE 与 TESTPILOT_ENV_ADMIN_PASSWORD");
  }

  onStage("打开目标页面");
  const handle = await (deps.openPage ?? openPage)({
    target: input.target,
    url: resolved.url,
    pilotUrl: input.pilotUrl,
    realUrl: input.realUrl,
    loginPath: input.loginPath,
  });
  try {
    onStage("采集页面与信号");
    const collectOptions =
      input.target === "real"
        ? { maxRoutes: 10, settleMs: 2_500, routeTimeoutMs: 30_000, expandWaitMs: 5_000 }
        : { maxRoutes: 12 };
    const collect =
      deps.collect ?? ((page: Page) => collectSystemProfile(page, collectOptions));
    const collected = await collect(handle.page);

    onStage("LLM 分析能力");
    const analysis = await (deps.analyze ?? analyzeCapabilitiesWithLlm)(collected);
    const enriched = mergeLlmAnalysis(collected, analysis);
    const withoutEvidence = { ...enriched };
    delete withoutEvidence.evidence;
    const profile = sanitizeProfile(withoutEvidence, input.target === "real");

    onStage("保存系统画像");
    const id = `detect_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const record: DetectionRecord = {
      id,
      sessionId: sessionIdForDetect(id),
      target: input.target,
      url: resolved.url,
      createdAt: new Date().toISOString(),
      profile,
    };
    await saveDetection(input.dataRoot, record);
    onStage("完成");
    return record;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function openPage(input: OpenPageInput): Promise<{ page: Page; close: () => Promise<void> }> {
  if (input.target === "pilot") {
    const { browser, page } = await openPilotPage(input.pilotUrl ?? "", input.url, {
      loginPath: input.loginPath,
    });
    return { page, close: () => browser.close() };
  }
  if (input.target === "real") {
    const { browser, page } = await openRealPage(input.realUrl ?? "");
    return { page, close: () => browser.close() };
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1_000);
    return { page, close: () => browser.close() };
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err;
  }
}

/**
 * Real-environment profiles keep capability/signal/route evidence but drop page
 * text and titles so stored artifacts do not contain people or project names.
 */
function sanitizeProfile(profile: SystemProfile, stripText: boolean): SystemProfile {
  const llmCapabilities =
    stripText && profile.llmCapabilities
      ? profile.llmCapabilities.map((capability) => ({
          ...capability,
          label: redactStringBody(capability.label),
          evidence: capability.evidence.map(redactStringBody),
          subCapabilities: capability.subCapabilities.map(redactStringBody),
          testIdeas: capability.testIdeas.map(redactStringBody),
          unknowns: capability.unknowns.map(redactStringBody),
        }))
      : profile.llmCapabilities;
  return {
    ...profile,
    capabilities: stripText
      ? profile.capabilities.map((capability) => ({
          ...capability,
          ...(capability.testIdeas
            ? { testIdeas: capability.testIdeas.map(redactStringBody) }
            : {}),
        }))
      : profile.capabilities,
    surfaces: profile.surfaces.map((surface) => ({
      route: surface.route,
      elements: surface.elements.map((element) => ({
        role: element.role,
        testId: element.testId,
        inputType: element.inputType,
        ...(stripText
          ? {}
          : { name: element.name ? redactStringBody(element.name) : element.name }),
      })),
      ...(stripText ? {} : { title: surface.title ? redactStringBody(surface.title) : surface.title }),
    })),
    signals: profile.signals.map((signal) => ({
      ...signal,
      evidence: signal.evidence.map((evidence) => ({
        ...evidence,
        summary: stripText ? signal.id : redactStringBody(evidence.summary),
      })),
    })),
    ...(llmCapabilities ? { llmCapabilities } : {}),
    ...(stripText && profile.llmSummary
      ? { llmSummary: redactStringBody(profile.llmSummary) }
      : {}),
    ...(stripText && profile.llmQuestions
      ? { llmQuestions: profile.llmQuestions.map(redactStringBody) }
      : {}),
  };
}

export async function saveDetection(dataRoot: string, record: DetectionRecord): Promise<void> {
  const dir = sessionDir(dataRoot, record.sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(sessionProfilePath(dataRoot, record.sessionId), JSON.stringify(record, null, 2));
  const meta: SessionMeta = {
    id: record.sessionId,
    kind: "detect",
    startedAt: record.createdAt,
    completedAt: record.createdAt,
    status: "completed",
    runIds: [],
    target: record.target,
    url: record.url,
  };
  await writeFile(sessionMetaPath(dataRoot, record.sessionId), JSON.stringify(meta, null, 2));
}

export async function readDetection(
  dataRoot: string,
  detectionId: string,
): Promise<DetectionRecord | undefined> {
  if (!isSafeRunId(detectionId)) return undefined;
  const sessionId = sessionIdForDetect(detectionId);
  try {
    return JSON.parse(
      await readFile(sessionProfilePath(dataRoot, sessionId), "utf8"),
    ) as DetectionRecord;
  } catch {
    return undefined;
  }
}

export async function listDetections(
  dataRoot: string,
  limit = 20,
): Promise<DetectionRecord[]> {
  const entries = await readdir(sessionsRoot(dataRoot), { withFileTypes: true }).catch(() => []);
  const records: DetectionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("session_detect_")) continue;
    const detectionId = entry.name.replace(/^session_/, "");
    const record = await readDetection(dataRoot, detectionId);
    if (record) records.push(record);
  }
  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return records.slice(0, Math.max(1, limit));
}

export async function latestDetection(
  dataRoot: string,
  target: DetectionTarget,
  url?: string,
): Promise<DetectionRecord | undefined> {
  const records = await listDetections(dataRoot, 50);
  return records.find((record) => {
    if (record.target !== target) return false;
    if (target !== "custom" || !url?.trim()) return true;
    return sameOrigin(record.url, url);
  });
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

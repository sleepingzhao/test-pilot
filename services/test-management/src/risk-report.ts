import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CapabilityAssessment, DetectionReport } from "@testpilot/detect";
import { resolveBaseUrl } from "@testpilot/fixtures";
import type { StoredTest } from "./store.js";
import { buildRunEnvironment } from "./run-env.js";

export type RiskCategory =
  | "data-lifecycle"
  | "authz"
  | "money-order"
  | "realtime"
  | "concurrency"
  | "validation"
  | "privacy"
  | "reliability"
  | "compatibility"
  | "coverage";

export type RiskItem = {
  id: string;
  title: string;
  category: RiskCategory;
  severity: "high" | "medium" | "low";
  confidence: number;
  capabilityIds: string[];
  evidenceRefs: string[];
  assumption?: true;
  testIdeas: string[];
  missingInfo: string[];
  suggestedMechanism?: "file-media" | "realtime-messaging" | "api" | "ui" | "none";
};

export type RiskReport = {
  id: string;
  detectionId: string;
  createdAt: string;
  inputHash: string;
  source: "rules" | "rules+llm";
  model?: string;
  tokensUsed?: number;
  risks: RiskItem[];
  blockers: string[];
  questions: string[];
  llm?: { used: boolean; error?: string };
};

type TestFacts = {
  id: string;
  title: string;
  approved: boolean;
  draft: boolean;
  allowMutation: boolean;
  cleanupConfigured: boolean;
  hasUpload: boolean;
  hasSecondActor: boolean;
  hasStructuredEvidence: boolean;
  requestMethods: Set<string>;
  text: string;
};

const WRITE_CAPABILITIES = new Set(["crud", "workflow", "file-media"]);
const HIGH_IMPACT = new Set(["crud", "workflow", "realtime-messaging", "file-media", "auth"]);

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function testFacts(test: StoredTest): TestFacts {
  return {
    id: test.id,
    title: test.title,
    approved: test.approvalStatus === "approved",
    draft: test.approvalStatus === "draft",
    allowMutation: test.ir.policy?.allowMutation === true,
    cleanupConfigured: test.ir.policy?.cleanup === "always" || test.ir.policy?.cleanup === "on-success",
    hasUpload: test.ir.steps.some((s) => s.action === "upload") || (test.ir.teardownSteps ?? []).some((s) => s.action === "upload"),
    hasSecondActor: (test.ir.actors?.length ?? 0) >= 2,
    hasStructuredEvidence: test.ir.assertions.some((a) => a.type !== "ui"),
    requestMethods: new Set(
      [...test.ir.steps, ...(test.ir.teardownSteps ?? [])]
        .filter((s) => s.action === "request")
        .map((s) => String(s.method ?? "").toUpperCase()),
    ),
    text: [
      test.title,
      ...test.ir.steps.flatMap((s) => [s.path, s.value, s.target?.name, s.target?.placeholder, s.target?.label]),
      ...test.ir.assertions.flatMap((a) => [a.contains, a.target?.name, a.expect ? JSON.stringify(a.expect) : undefined]),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
  };
}

function covers(capability: string, facts: TestFacts): boolean {
  const text = facts.text;
  switch (capability) {
    case "crud":
      return ["POST", "PUT", "PATCH", "DELETE"].some((m) => facts.requestMethods.has(m)) ||
        /新建|添加|编辑|删除|保存|创建/.test(text);
    case "workflow":
      return /审批|通过|驳回|状态|取消|关闭|归档|流转/.test(text);
    case "realtime-messaging":
      return facts.hasSecondActor || /消息|聊天|websocket|ws\b/.test(text);
    case "file-media":
      return facts.hasUpload || /上传|附件|文件/.test(text);
    case "auth":
      return /权限|越权|403|登录失败|角色|隔离/.test(text);
    case "search-filter":
      return /搜索|筛选|过滤/.test(text);
    case "agent":
      return /agent|工具调用|mcp|技能|智能体/.test(text);
    case "rich-content":
      return /引用|流式|富文本|markdown/.test(text);
    default:
      return false;
  }
}

function evidenceRefsOf(cap: CapabilityAssessment): string[] {
  return [...cap.evidenceIds];
}

function risk(
  capability: CapabilityAssessment,
  input: {
    title: string;
    category: RiskCategory;
    severity: RiskItem["severity"];
    testIdeas: string[];
    missingInfo?: string[];
    suggestedMechanism?: RiskItem["suggestedMechanism"];
    confidence?: number;
  },
): RiskItem {
  return {
    id: `risk-${randomUUID().slice(0, 8)}`,
    title: input.title,
    category: input.category,
    severity: input.severity,
    confidence: input.confidence ?? Math.min(0.9, 0.5 + capability.confidence / 2),
    capabilityIds: [capability.id],
    evidenceRefs: evidenceRefsOf(capability),
    testIdeas: input.testIdeas,
    missingInfo: input.missingInfo ?? capability.unknowns,
    ...(input.suggestedMechanism ? { suggestedMechanism: input.suggestedMechanism } : {}),
  };
}

export function buildRiskReport(input: {
  detectionId: string;
  profile: DetectionReport;
  tests: StoredTest[];
  targetMode: "demo" | "custom" | "pilot" | "real";
  now?: Date;
}): RiskReport {
  const env = buildRunEnvironment(input.profile.target.url);
  const detectionOrigin = originOf(input.profile.target.url);
  const relevant = input.tests
    .map((test) => ({ test, facts: testFacts(test) }))
    .filter(({ test }) => {
      if (!detectionOrigin) return true;
      const target = resolveBaseUrl(test.ir, env);
      const origin = target ? originOf(target) : null;
      return !origin || origin === detectionOrigin;
    });
  const approved = relevant.filter(({ facts }) => facts.approved).map(({ facts }) => facts);
  const drafts = relevant.filter(({ facts }) => facts.draft).map(({ facts }) => facts);
  const caps = input.profile.capabilities.filter((cap) => cap.confidence >= 0.6);
  const risks: RiskItem[] = [];
  const blockers: string[] = [];

  const writeCaps = caps.filter((cap) => WRITE_CAPABILITIES.has(cap.id));
  const coveredByWrite = (cap: CapabilityAssessment) => approved.filter((facts) => covers(cap.id, facts));

  // 1. Write capability without any approved test that cleans its data.
  if (writeCaps.length && !approved.some((facts) => facts.cleanupConfigured)) {
    const cap = writeCaps[0]!;
    risks.push(
      risk(cap, {
        title: "存在写能力，但已批准用例没有数据清理策略",
        category: "data-lifecycle",
        severity: "high",
        testIdeas: [
          "为写入流程补 teardown，使用 saveFields 变量删除本次创建的数据",
          "在回归后核对列表/接口，确认测试数据已清理",
        ],
        missingInfo: ["需要确认哪些写接口允许测试账号调用", "需要确认清理接口与权限"],
        suggestedMechanism: "ui",
      }),
    );
  }

  // 2. File/media capability without an upload test.
  const fileMedia = caps.find((cap) => cap.id === "file-media");
  if (fileMedia && !approved.some((facts) => facts.hasUpload)) {
    risks.push(
      risk(fileMedia, {
        title: "识别到文件/媒体能力，但没有上传用例",
        category: "validation",
        severity: "high",
        testIdeas: [
          "补正常上传用例，并用接口证据确认文件落地",
          "补类型/大小边界负例",
        ],
        missingInfo: ["需要确认允许的类型、大小与数量限制"],
        suggestedMechanism: "file-media",
      }),
    );
  }

  // 3. Realtime capability without second-actor evidence.
  const realtime = caps.find((cap) => cap.id === "realtime-messaging");
  const hasSecondActorEvidence = input.profile.signals.some((signal) => signal.id === "evidence.second-actor");
  if (realtime && !hasSecondActorEvidence && !approved.some((facts) => facts.hasSecondActor)) {
    risks.push(
      risk(realtime, {
        title: "识别到实时消息能力，但没有第二账号送达证据",
        category: "realtime",
        severity: "high",
        testIdeas: ["用两个 actor 互发消息，并断言接收方收到同一内容"],
        missingInfo: ["需要第二账号与可见的会话入口"],
        suggestedMechanism: "realtime-messaging",
      }),
    );
  }

  // 4. Auth capability without permission/forbidden coverage.
  const auth = caps.find((cap) => cap.id === "auth");
  if (auth && !approved.some((facts) => covers("auth", facts))) {
    risks.push(
      risk(auth, {
        title: "识别到认证/角色能力，但没有权限或越权用例",
        category: "authz",
        severity: "high",
        testIdeas: ["用低权限账号访问管理员接口，断言 403", "校验两个角色看到的菜单/数据范围不同"],
        missingInfo: ["需要至少两个角色或租户的账号"],
        suggestedMechanism: "ui",
      }),
    );
  }

  // 5. High-confidence capability with no approved coverage.
  for (const cap of caps.filter((item) => item.confidence >= 0.8)) {
    if (coveredByWrite(cap).length > 0) continue;
    if (risks.some((item) => item.capabilityIds.includes(cap.id) && item.severity === "high")) continue;
    risks.push(
      risk(cap, {
        title: `能力「${cap.id}」置信度高但没有已批准用例覆盖`,
        category: "coverage",
        severity: "medium",
        testIdeas: ["先为该能力生成 1–2 条只读冒烟用例", "补齐后纳入批量回归"],
        confidence: cap.confidence,
        suggestedMechanism: "none",
      }),
    );
  }

  // 6. High-impact capability with unresolved unknowns.
  const unknownCaps = caps.filter((cap) => HIGH_IMPACT.has(cap.id) && cap.unknowns.length > 0);
  if (unknownCaps.length) {
    risks.push({
      id: `risk-${randomUUID().slice(0, 8)}`,
      title: "高影响能力仍有未确认的约束",
      category: "validation",
      severity: "medium",
      confidence: 0.7,
      capabilityIds: unknownCaps.map((cap) => cap.id),
      evidenceRefs: unknownCaps.flatMap((cap) => cap.evidenceIds),
      testIdeas: ["把 unknowns 转成待确认问题，确认后补边界用例"],
      missingInfo: unknownCaps.flatMap((cap) => cap.unknowns),
      suggestedMechanism: "none",
    });
  }

  // 7. Write flows backed only by UI assertions.
  if (writeCaps.length) {
    const writeTests = approved.filter((facts) => writeCaps.some((cap) => covers(cap.id, facts)));
    if (writeTests.length && !writeTests.some((facts) => facts.hasStructuredEvidence)) {
      risks.push({
        id: `risk-${randomUUID().slice(0, 8)}`,
        title: "写流程只有 UI 断言，缺少接口/DB/事件证据",
        category: "reliability",
        severity: "medium",
        confidence: 0.75,
        capabilityIds: writeCaps.map((cap) => cap.id),
        evidenceRefs: writeCaps.flatMap((cap) => cap.evidenceIds),
        testIdeas: ["为写流程补 captured-http 断言", "条件允许时补 DB 只读或事件断言"],
        missingInfo: ["需要接口路径或只读数据源"],
        suggestedMechanism: "api",
      });
    }
  }

  // 8. Blockers: write drafts against pilot/real targets.
  if (input.targetMode === "pilot" || input.targetMode === "real") {
    const writeDrafts = drafts.filter(
      (facts) => facts.allowMutation || [...facts.requestMethods].some((m) => m !== "GET" && m !== "HEAD"),
    );
    if (writeDrafts.length) {
      blockers.push(
        `${writeDrafts.length} 条草稿在${
          input.targetMode === "real" ? "真实" : "试点"
        }环境包含写操作（${writeDrafts.map((facts) => facts.title).join("、")}）；该环境只允许只读`,
      );
    }
  }

  const severityRank = { high: 0, medium: 1, low: 2 } as const;
  risks.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  const questions = [
    ...input.profile.questions.map((question) => question.question),
    ...risks.flatMap((item) => item.missingInfo),
  ].filter((value, index, list) => list.indexOf(value) === index).slice(0, 20);

  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        detectionId: input.detectionId,
        capabilities: input.profile.capabilities.map((cap) => [cap.id, cap.confidence, cap.unknowns]),
        signals: input.profile.signals.map((signal) => signal.id).sort(),
        tests: relevant.map(({ test }) => [test.id, test.approvalStatus, test.irHash ?? ""]),
      }),
    )
    .digest("hex")
    .slice(0, 16);

  return {
    id: `risk_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    detectionId: input.detectionId,
    createdAt: (input.now ?? new Date()).toISOString(),
    inputHash,
    source: "rules",
    risks,
    blockers,
    questions,
    llm: { used: false },
  };
}

export async function saveRiskReport(dataRoot: string, report: RiskReport): Promise<string> {
  const dir = join(dataRoot, "risk-reports");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${report.id}.json`);
  await writeFile(path, JSON.stringify(report, null, 2));
  return path;
}

export async function readLatestRiskReport(
  dataRoot: string,
  detectionId: string,
): Promise<RiskReport | undefined> {
  const dir = join(dataRoot, "risk-reports");
  const files = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".json")).sort().reverse();
  for (const name of files) {
    try {
      const report = JSON.parse(await readFile(join(dir, name), "utf8")) as RiskReport;
      if (report.detectionId === detectionId) return report;
    } catch {
      /* skip corrupt */
    }
  }
  return undefined;
}

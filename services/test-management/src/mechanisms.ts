import type { Locator, TestStep } from "@testpilot/test-ir";
import {
  planFileMedia,
  planRealtimeMessaging,
  type FileMediaContext,
  type FileMediaScenarioKind,
  type RealtimeContext,
  type RealtimeScenarioKind,
} from "@testpilot/mechanisms";

export type { FileMediaScenarioKind, RealtimeScenarioKind } from "@testpilot/mechanisms";
import type { DetectionRecord, DetectionTarget } from "./detection.js";

const PILOT_REAL_BLOCKER =
  "试点/真实环境不生成会写入数据的机制草稿；请在练习或明确授权的可写环境使用";

const DEFAULT_PAGE_PATH = "/files";
const DEFAULT_UPLOAD_REF = "fixture.samplePng";
const DEFAULT_FILE_NAME = "sample.png";
const DEFAULT_UPLOAD_REQUEST_REF = "files-upload";
const DEFAULT_UPLOAD_TARGET = "file-input";
const DEFAULT_SUBMIT_TARGET = "file-upload-submit";
const DEFAULT_LIST_TARGET = "file-list";

function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function locatorFromTestId(testId: string | undefined, fallback: string): Locator {
  return { testId: testId ?? fallback };
}

export function buildFileMediaContext(
  input: Record<string, unknown> = {},
  target: DetectionTarget = "custom",
): FileMediaContext {
  const pagePath = readString(input, "pagePath") ?? DEFAULT_PAGE_PATH;
  const uploadRef = readString(input, "uploadRef") ?? DEFAULT_UPLOAD_REF;
  const fileName = readString(input, "fileName") ?? DEFAULT_FILE_NAME;
  const uploadRequestRef = readString(input, "uploadRequestRef") ?? DEFAULT_UPLOAD_REQUEST_REF;

  const uploadTargetId = readString(input, "uploadTarget") ?? DEFAULT_UPLOAD_TARGET;
  const submitTargetId = readString(input, "submitTarget") ?? DEFAULT_SUBMIT_TARGET;
  const listTargetId = readString(input, "listTarget") ?? DEFAULT_LIST_TARGET;

  const ctx: FileMediaContext = {
    pagePath,
    uploadRef,
    fileName,
    uploadRequestRef,
    uploadTarget: locatorFromTestId(uploadTargetId, DEFAULT_UPLOAD_TARGET),
    submitTarget: locatorFromTestId(submitTargetId, DEFAULT_SUBMIT_TARGET),
    listTarget: locatorFromTestId(listTargetId, DEFAULT_LIST_TARGET),
  };

  const cleanupPath =
    readString(input, "cleanupPath") ??
    (target === "demo" ? "/api/files/{{uploadedId}}" : undefined);
  const cleanupMethod = readString(input, "cleanupMethod") ?? (cleanupPath ? "DELETE" : undefined);
  const cleanupIdField = readString(input, "cleanupIdField") ?? "id";
  if (cleanupPath) {
    ctx.cleanup = { path: cleanupPath, idField: cleanupIdField };
    if (cleanupMethod) ctx.cleanup.method = cleanupMethod;
  }

  const invalidTypeRef = readString(input, "invalidTypeRef");
  const invalidTypeName = readString(input, "invalidTypeName");
  const oversizeRef = readString(input, "oversizeRef");
  const oversizeName = readString(input, "oversizeName");
  if (invalidTypeRef) ctx.invalidTypeRef = invalidTypeRef;
  if (invalidTypeName) ctx.invalidTypeName = invalidTypeName;
  if (oversizeRef) ctx.oversizeRef = oversizeRef;
  if (oversizeName) ctx.oversizeName = oversizeName;

  return ctx;
}

export type PublicFileMediaContext = {
  pagePath?: string;
  uploadRef: string;
  fileName: string;
  uploadRequestRef: string;
  uploadTarget?: string;
  submitTarget?: string;
  listTarget?: string;
  invalidTypeRef?: string;
  invalidTypeName?: string;
  oversizeRef?: string;
  oversizeName?: string;
  cleanupPath?: string;
  cleanupMethod?: string;
  cleanupIdField?: string;
};

export function publicFileMediaContext(ctx: FileMediaContext): PublicFileMediaContext {
  const out: PublicFileMediaContext = {
    uploadRef: ctx.uploadRef,
    fileName: ctx.fileName,
    uploadRequestRef: ctx.uploadRequestRef,
  };
  if (ctx.pagePath) out.pagePath = ctx.pagePath;
  if (ctx.uploadTarget?.testId) out.uploadTarget = ctx.uploadTarget.testId;
  if (ctx.submitTarget?.testId) out.submitTarget = ctx.submitTarget.testId;
  if (ctx.listTarget?.testId) out.listTarget = ctx.listTarget.testId;
  if (ctx.invalidTypeRef) out.invalidTypeRef = ctx.invalidTypeRef;
  if (ctx.invalidTypeName) out.invalidTypeName = ctx.invalidTypeName;
  if (ctx.oversizeRef) out.oversizeRef = ctx.oversizeRef;
  if (ctx.oversizeName) out.oversizeName = ctx.oversizeName;
  if (ctx.cleanup?.path) {
    out.cleanupPath = ctx.cleanup.path;
    out.cleanupMethod = ctx.cleanup.method ?? "DELETE";
    out.cleanupIdField = ctx.cleanup.idField ?? "id";
  }
  return out;
}

export type PublicRealtimeContext = {
  pagePath?: string;
  composerTestId?: string;
  sendTestId?: string;
  listTestId?: string;
  wsUrlIncludes?: string;
  text?: string;
  senderActor?: string;
  receiverActor?: string;
  messageCount?: number;
  maxLength?: number;
  overlongText?: string;
  imageTestId?: string;
  imageButtonTestId?: string;
  reconnectQuery?: string;
  reconnectCountTestId?: string;
};

export type MechanismPlanEntry =
  | {
      id: "file-media";
      runnable: boolean;
      blockers: string[];
      context: PublicFileMediaContext;
      scenarios: Array<{ id: string; kind: FileMediaScenarioKind }>;
    }
  | {
      id: "realtime-messaging";
      runnable: boolean;
      blockers: string[];
      context: PublicRealtimeContext;
      scenarios: Array<{ id: string; kind: RealtimeScenarioKind }>;
    };

export type MechanismPlanResponse = {
  detectionId: string;
  target: DetectionTarget;
  mechanisms: MechanismPlanEntry[];
};

const DEFAULT_REALTIME_PAGE = "/chat";
const DEFAULT_COMPOSER = "chat-composer";
const DEFAULT_SEND = "chat-send";
const DEFAULT_LIST = "chat-list";
const DEFAULT_WS_INCLUDES = "/ws/chat";
const DEFAULT_TEXT = "测试消息";
const DEFAULT_SENDER = "sender";
const DEFAULT_RECEIVER = "receiver";
const DEFAULT_IMAGE_TEST = "chat-image";
const DEFAULT_IMAGE_BUTTON = "chat-send-image";

function readMaxLength(input: Record<string, unknown>): number | undefined {
  const asString = readString(input, "maxLength");
  if (asString !== undefined) {
    const n = Number(asString);
    if (Number.isInteger(n)) return n;
    return Number.NaN;
  }
  if (typeof input.maxLength === "number" && Number.isInteger(input.maxLength)) {
    return input.maxLength;
  }
  return undefined;
}

function readMessageCount(input: Record<string, unknown>): number | undefined {
  const asString = readString(input, "messageCount");
  if (asString !== undefined) {
    const n = Number(asString);
    if (Number.isInteger(n)) return n;
    return Number.NaN;
  }
  if (typeof input.messageCount === "number" && Number.isInteger(input.messageCount)) {
    return input.messageCount;
  }
  return undefined;
}

export function buildRealtimeContext(input: Record<string, unknown> = {}): RealtimeContext {
  const pagePath = readString(input, "pagePath") ?? DEFAULT_REALTIME_PAGE;
  const ctx: RealtimeContext = {
    pagePath,
    composerTestId: readString(input, "composerTestId") ?? DEFAULT_COMPOSER,
    sendTestId: readString(input, "sendTestId") ?? DEFAULT_SEND,
    listTestId: readString(input, "listTestId") ?? DEFAULT_LIST,
    wsUrlIncludes: readString(input, "wsUrlIncludes") ?? DEFAULT_WS_INCLUDES,
    text: readString(input, "text") ?? DEFAULT_TEXT,
    senderActor: readString(input, "senderActor") ?? DEFAULT_SENDER,
    receiverActor: readString(input, "receiverActor") ?? DEFAULT_RECEIVER,
  };
  const messageCount = readMessageCount(input);
  if (messageCount !== undefined) ctx.messageCount = messageCount;
  const maxLength = readMaxLength(input);
  if (maxLength !== undefined) ctx.maxLength = maxLength;
  const overlongText = readString(input, "overlongText");
  if (overlongText !== undefined) ctx.overlongText = overlongText;
  const senderLogin = readLoginSteps(input, "senderLoginSteps");
  const receiverLogin = readLoginSteps(input, "receiverLoginSteps");
  if (senderLogin) ctx.senderLoginSteps = senderLogin;
  if (receiverLogin) ctx.receiverLoginSteps = receiverLogin;
  ctx.imageTestId = readString(input, "imageTestId") ?? DEFAULT_IMAGE_TEST;
  ctx.imageButtonTestId = readString(input, "imageButtonTestId") ?? DEFAULT_IMAGE_BUTTON;
  const reconnectQuery = readString(input, "reconnectQuery");
  if (reconnectQuery !== undefined) ctx.reconnectQuery = reconnectQuery;
  const reconnectCountTestId = readString(input, "reconnectCountTestId");
  if (reconnectCountTestId !== undefined) ctx.reconnectCountTestId = reconnectCountTestId;
  return ctx;
}

function readLoginSteps(input: Record<string, unknown>, key: string): TestStep[] | undefined {
  const raw = input[key];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw as TestStep[];
}

export function publicRealtimeContext(ctx: RealtimeContext): PublicRealtimeContext {
  const out: PublicRealtimeContext = {};
  if (ctx.pagePath) out.pagePath = ctx.pagePath;
  if (ctx.composerTestId) out.composerTestId = ctx.composerTestId;
  if (ctx.sendTestId) out.sendTestId = ctx.sendTestId;
  if (ctx.listTestId) out.listTestId = ctx.listTestId;
  if (ctx.wsUrlIncludes) out.wsUrlIncludes = ctx.wsUrlIncludes;
  if (ctx.text) out.text = ctx.text;
  if (ctx.senderActor) out.senderActor = ctx.senderActor;
  if (ctx.receiverActor) out.receiverActor = ctx.receiverActor;
  if (ctx.messageCount !== undefined) out.messageCount = ctx.messageCount;
  if (ctx.maxLength !== undefined) out.maxLength = ctx.maxLength;
  if (ctx.overlongText) out.overlongText = ctx.overlongText;
  if (ctx.imageTestId) out.imageTestId = ctx.imageTestId;
  if (ctx.imageButtonTestId) out.imageButtonTestId = ctx.imageButtonTestId;
  if (ctx.reconnectQuery) out.reconnectQuery = ctx.reconnectQuery;
  if (ctx.reconnectCountTestId) out.reconnectCountTestId = ctx.reconnectCountTestId;
  return out;
}

function fileMediaPlanEntry(
  record: DetectionRecord,
  target: DetectionTarget,
  ctxInput: Record<string, unknown>,
): MechanismPlanEntry {
  const ctx = buildFileMediaContext(ctxInput, target);
  const profile = capabilityProfile(record);
  const plan = planFileMedia(profile, ctx);
  const scenarios = plan.scenarios.map((scenario) => ({ id: scenario.id, kind: scenario.kind }));
  const context = publicFileMediaContext(ctx);
  const blockers =
    target === "real" || target === "pilot"
      ? [PILOT_REAL_BLOCKER, ...plan.blockers.filter((b) => b !== PILOT_REAL_BLOCKER)]
      : plan.blockers;
  const runnable = target === "real" || target === "pilot" ? false : plan.runnable;
  return { id: "file-media", runnable, blockers, context, scenarios };
}

function realtimePlanEntry(
  record: DetectionRecord,
  target: DetectionTarget,
  ctxInput: Record<string, unknown>,
): MechanismPlanEntry {
  const ctx = buildRealtimeContext(ctxInput);
  const profile = capabilityProfile(record);
  const plan = planRealtimeMessaging(profile, ctx);
  const scenarios = plan.scenarios.map((scenario) => ({ id: scenario.id, kind: scenario.kind }));
  const context = publicRealtimeContext(ctx);
  const blockers =
    target === "real" || target === "pilot"
      ? [PILOT_REAL_BLOCKER, ...plan.blockers.filter((b) => b !== PILOT_REAL_BLOCKER)]
      : plan.blockers;
  const runnable = target === "real" || target === "pilot" ? false : plan.runnable;
  return { id: "realtime-messaging", runnable, blockers, context, scenarios };
}

function capabilityProfile(record: DetectionRecord) {
  return {
    capabilities: record.profile.capabilities.map((capability) => ({
      id: capability.id,
      confidence: capability.confidence,
    })),
  };
}

export function mechanismPlanForRecord(
  record: DetectionRecord,
  target: DetectionTarget,
  ctxInput: Record<string, unknown> = {},
): MechanismPlanResponse {
  return {
    detectionId: record.id,
    target,
    mechanisms: [
      fileMediaPlanEntry(record, target, ctxInput),
      realtimePlanEntry(record, target, ctxInput),
    ],
  };
}

export const FILE_MEDIA_SCENARIO_LABELS: Record<FileMediaScenarioKind, string> = {
  happy: "正常上传",
  "invalid-type": "类型不符",
  oversize: "超过大小",
};

export function fileMediaScenarioIr(
  record: DetectionRecord,
  scenario: FileMediaScenarioKind,
  ctxInput: Record<string, unknown>,
) {
  const ctx = buildFileMediaContext(ctxInput, record.target);
  const profile = capabilityProfile(record);
  const plan = planFileMedia(profile, ctx);
  return { plan, scenarioIr: plan.scenarios.find((item) => item.kind === scenario) };
}

export function realtimeScenarioIr(
  record: DetectionRecord,
  scenario: RealtimeScenarioKind,
  ctxInput: Record<string, unknown>,
) {
  const ctx = buildRealtimeContext(ctxInput);
  const profile = capabilityProfile(record);
  const plan = planRealtimeMessaging(profile, ctx);
  return { plan, scenarioIr: plan.scenarios.find((item) => item.kind === scenario) };
}

export const REALTIME_SCENARIO_LABELS: Record<RealtimeScenarioKind, string> = {
  text: "文本送达",
  dedupe: "多消息去重",
  oversize: "超长消息",
  order: "严格顺序",
  image: "图片消息",
  reconnect: "断线重连",
};

export { PILOT_REAL_BLOCKER };

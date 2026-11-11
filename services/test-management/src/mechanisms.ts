import type { Locator } from "@testpilot/test-ir";
import {
  planFileMedia,
  type FileMediaContext,
  type FileMediaScenarioKind,
} from "@testpilot/mechanisms";

export type { FileMediaScenarioKind } from "@testpilot/mechanisms";
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

export function buildFileMediaContext(input: Record<string, unknown> = {}): FileMediaContext {
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
  return out;
}

export type MechanismPlanEntry = {
  id: "file-media";
  runnable: boolean;
  blockers: string[];
  context: PublicFileMediaContext;
  scenarios: Array<{ id: string; kind: FileMediaScenarioKind }>;
};

export type MechanismPlanResponse = {
  detectionId: string;
  target: DetectionTarget;
  mechanisms: MechanismPlanEntry[];
};

export function mechanismPlanForRecord(
  record: DetectionRecord,
  target: DetectionTarget,
  ctxInput: Record<string, unknown> = {},
): MechanismPlanResponse {
  const ctx = buildFileMediaContext(ctxInput);
  const profile = {
    capabilities: record.profile.capabilities.map((capability) => ({
      id: capability.id,
      confidence: capability.confidence,
    })),
  };
  const plan = planFileMedia(profile, ctx);
  const scenarios = plan.scenarios.map((scenario) => ({ id: scenario.id, kind: scenario.kind }));
  const context = publicFileMediaContext(ctx);

  if (target === "real" || target === "pilot") {
    return {
      detectionId: record.id,
      target,
      mechanisms: [
        {
          id: "file-media",
          runnable: false,
          blockers: [PILOT_REAL_BLOCKER, ...plan.blockers.filter((b) => b !== PILOT_REAL_BLOCKER)],
          context,
          scenarios,
        },
      ],
    };
  }

  return {
    detectionId: record.id,
    target,
    mechanisms: [
      {
        id: "file-media",
        runnable: plan.runnable,
        blockers: plan.blockers,
        context,
        scenarios,
      },
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
  const ctx = buildFileMediaContext(ctxInput);
  const profile = {
    capabilities: record.profile.capabilities.map((capability) => ({
      id: capability.id,
      confidence: capability.confidence,
    })),
  };
  const plan = planFileMedia(profile, ctx);
  return { plan, scenarioIr: plan.scenarios.find((item) => item.kind === scenario) };
}

export { PILOT_REAL_BLOCKER };

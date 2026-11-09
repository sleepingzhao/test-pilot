import type { Locator, TestAssertion, TestIR, TestStep } from "@testpilot/test-ir";

const FILE_MEDIA_CONFIDENCE = 0.6;

export type FileMediaProfile = {
  capabilities?: ReadonlyArray<{ id: string; confidence: number }>;
};

export type FileMediaContext = {
  pagePath?: string;
  uploadRef: string;
  fileName: string;
  uploadRequestRef: string;
  uploadTarget?: Locator;
  submitTarget?: Locator;
  listTarget?: Locator;
  invalidTypeRef?: string;
  invalidTypeName?: string;
  oversizeRef?: string;
  oversizeName?: string;
};

export type FileMediaScenarioKind = "happy" | "invalid-type" | "oversize";

export type FileMediaScenario = {
  id: string;
  kind: FileMediaScenarioKind;
  ir: TestIR;
};

export type FileMediaPlan = {
  mechanism: "file-media";
  runnable: boolean;
  blockers: string[];
  scenarios: FileMediaScenario[];
};

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function fileMediaConfidence(profile: FileMediaProfile): number | undefined {
  const scores = (profile.capabilities ?? [])
    .filter((capability) => capability.id === "file-media")
    .map((capability) => capability.confidence);
  if (scores.length === 0) return undefined;
  return Math.max(...scores);
}

function locator(override: Locator | undefined, testId: string): Locator {
  return override ?? { testId };
}

function scenarioIr(
  id: string,
  ctx: FileMediaContext,
  valueRef: string,
  assertion: TestAssertion,
): TestIR {
  const steps: TestStep[] = [
    { id: "open-page", action: "navigate", path: present(ctx.pagePath) ?? "/files" },
    {
      id: "choose-file",
      action: "upload",
      target: locator(ctx.uploadTarget, "file-input"),
      valueRef,
    },
    {
      id: "submit-upload",
      action: "click",
      target: locator(ctx.submitTarget, "file-upload-submit"),
    },
  ];
  return {
    id,
    version: 1,
    platform: "web",
    steps,
    assertions: [assertion],
    policy: { screenshots: "on-failure" },
  };
}

function apiAssertion(id: string, requestRef: string, expect: Record<string, unknown>): TestAssertion {
  return {
    id,
    type: "api",
    provider: "captured-http",
    requestRef,
    expect,
    oracle: "api-contract",
  };
}

export function planFileMedia(profile: FileMediaProfile, ctx: FileMediaContext): FileMediaPlan {
  const confidence = fileMediaConfidence(profile);
  if (confidence === undefined || confidence < FILE_MEDIA_CONFIDENCE) {
    const reason =
      confidence === undefined
        ? "画像没有 file-media 能力（需要 confidence ≥ 0.6），不生成 IR"
        : `file-media 置信度 ${confidence} 低于 0.6，不生成 IR`;
    return { mechanism: "file-media", runnable: false, blockers: [reason], scenarios: [] };
  }

  const blockers: string[] = [];
  const uploadRef = present(ctx.uploadRef);
  const fileName = present(ctx.fileName);
  const uploadRequestRef = present(ctx.uploadRequestRef);
  if (!uploadRef || !fileName || !uploadRequestRef) {
    blockers.push("file-media 需要 uploadRef、fileName 和 uploadRequestRef，不生成 IR");
    return { mechanism: "file-media", runnable: false, blockers, scenarios: [] };
  }

  const scenarios: FileMediaScenario[] = [
    {
      id: "happy",
      kind: "happy",
      ir: {
        ...scenarioIr(
          "file-media-happy",
          ctx,
          uploadRef,
          apiAssertion("upload-created", uploadRequestRef, {
            statusCode: 201,
            responseJsonBody: { name: fileName },
          }),
        ),
        assertions: [
          apiAssertion("upload-created", uploadRequestRef, {
            statusCode: 201,
            responseJsonBody: { name: fileName },
          }),
          {
            id: "file-listed",
            type: "ui",
            target: locator(ctx.listTarget, "file-list"),
            contains: fileName,
            oracle: "requirement",
          },
        ],
      },
    },
  ];

  const invalidTypeRef = present(ctx.invalidTypeRef);
  if (!invalidTypeRef) {
    blockers.push(
      present(ctx.invalidTypeName)
        ? "提供了 invalidTypeName 但没有 invalidTypeRef，跳过 invalid-type 场景"
        : "未提供 invalidTypeRef，跳过 invalid-type 场景",
    );
  } else {
    scenarios.push({
      id: "invalid-type",
      kind: "invalid-type",
      ir: scenarioIr(
        "file-media-invalid-type",
        ctx,
        invalidTypeRef,
        apiAssertion("upload-rejected-type", uploadRequestRef, {
          statusCode: 415,
          responseJsonBody: { error: "unsupported_type" },
        }),
      ),
    });
  }

  const oversizeRef = present(ctx.oversizeRef);
  if (!oversizeRef) {
    blockers.push(
      present(ctx.oversizeName)
        ? "提供了 oversizeName 但没有 oversizeRef，跳过 oversize 场景"
        : "未提供 oversizeRef，跳过 oversize 场景",
    );
  } else {
    scenarios.push({
      id: "oversize",
      kind: "oversize",
      ir: scenarioIr(
        "file-media-oversize",
        ctx,
        oversizeRef,
        apiAssertion("upload-rejected-size", uploadRequestRef, { statusCode: 413 }),
      ),
    });
  }

  return { mechanism: "file-media", runnable: true, blockers, scenarios };
}

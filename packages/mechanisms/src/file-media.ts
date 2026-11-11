import type { Locator, RequestMethod, TestAssertion, TestIR, TestStep } from "@testpilot/test-ir";

const FILE_MEDIA_CONFIDENCE = 0.6;

export type FileMediaProfile = {
  capabilities?: ReadonlyArray<{ id: string; confidence: number }>;
};

export type FileMediaCleanup = {
  method?: string;
  path: string;
  idVar?: string;
  idField?: string;
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
  /** Delete the uploaded record after the run; only used by the happy scenario. */
  cleanup?: FileMediaCleanup;
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
  cleanup?: FileMediaCleanup,
): TestIR {
  const uploadStep: TestStep = {
    id: "choose-file",
    action: "upload",
    target: locator(ctx.uploadTarget, "file-input"),
    valueRef,
  };
  const submitStep: TestStep = {
    id: "submit-upload",
    action: "click",
    target: locator(ctx.submitTarget, "file-upload-submit"),
  };
  const steps: TestStep[] = [
    { id: "open-page", action: "navigate", path: present(ctx.pagePath) ?? "/files" },
    uploadStep,
    submitStep,
  ];
  const ir: TestIR = {
    id,
    version: 1,
    platform: "web",
    steps,
    assertions: [assertion],
    policy: { screenshots: "on-failure" },
  };
  if (cleanup) {
    const idVar = present(cleanup.idVar) ?? "uploadedId";
    submitStep.saveFromRef = ctx.uploadRequestRef;
    submitStep.saveFields = { [idVar]: present(cleanup.idField) ?? "id" };
    ir.policy = { screenshots: "on-failure", cleanup: "always" };
    ir.teardownSteps = [
      {
        id: "cleanup",
        action: "request",
        method: (present(cleanup.method) ?? "DELETE").toUpperCase() as RequestMethod,
        path: cleanup.path,
      },
    ];
  }
  return ir;
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

const CLEANUP_METHODS = new Set(["DELETE", "POST", "PUT", "PATCH"]);

function resolveCleanup(
  cleanup: FileMediaCleanup | undefined,
): { cleanup?: FileMediaCleanup; blocker?: string } {
  if (!cleanup) {
    return { blocker: "未配置 cleanupPath：上传成功后可能留下测试数据" };
  }
  const path = present(cleanup.path);
  if (!path) return { blocker: "cleanupPath 为空：不会生成清理步骤" };
  if (!path.startsWith("/") || path.includes("://")) {
    return { blocker: "cleanupPath 必须是同源相对路径（以 / 开头）" };
  }
  const idVar = present(cleanup.idVar) ?? "uploadedId";
  if (!path.includes(`{{${idVar}}}`)) {
    return { blocker: `cleanupPath 必须包含 {{${idVar}}}，否则会删错数据` };
  }
  const method = (present(cleanup.method) ?? "DELETE").toUpperCase();
  if (!CLEANUP_METHODS.has(method)) {
    return { blocker: `cleanupMethod 不支持 ${method}（可用 DELETE/POST/PUT/PATCH）` };
  }
  return {
    cleanup: {
      method,
      path,
      idVar,
      idField: present(cleanup.idField) ?? "id",
    },
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

  const cleanupResult = resolveCleanup(ctx.cleanup);
  if (cleanupResult.blocker) blockers.push(cleanupResult.blocker);

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
          cleanupResult.cleanup,
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

type StepLike = {
  action?: string;
  path?: string;
  method?: string;
  target?: { role?: string; name?: string; label?: string; placeholder?: string; testId?: string };
  valueRef?: string;
  key?: string;
};

export function describeStep(step: StepLike, index: number): string {
  const n = index + 1;
  const targetLabel =
    step.target?.label ??
    step.target?.name ??
    step.target?.placeholder ??
    step.target?.testId ??
    step.target?.role;
  switch (step.action) {
    case "navigate":
      return `${n}. 打开 ${step.path ?? "/"}`;
    case "click":
      return `${n}. 点击「${targetLabel ?? "元素"}」`;
    case "fill":
      return `${n}. 填写「${targetLabel ?? "字段"}」${step.valueRef ? "（凭据）" : ""}`;
    case "select":
      return `${n}. 选择「${targetLabel ?? "下拉框"}」`;
    case "press":
      return `${n}. 按键 ${step.key ?? "?"}`;
    case "wait":
      return `${n}. 等待${step.target ? "元素出现" : "页面稳定"}`;
    case "request":
      return `${n}. ${step.method ?? "GET"} ${step.path ?? "/"}`;
    default:
      return `${n}. ${step.action ?? "步骤"}`;
  }
}

export function failureKindLabel(kind?: string | null): string | null {
  if (!kind) return null;
  const map: Record<string, string> = {
    PRODUCT_DEFECT: "产品缺陷",
    LOCATOR_BREAKAGE: "定位失效",
    ENVIRONMENT: "环境异常",
    TEST_DATA: "测试数据",
    ASSERTION_ORACLE: "断言预期",
    UNKNOWN: "未知",
  };
  return map[kind] ?? kind;
}

export type AssertionSummary = {
  id?: string;
  type?: string;
  contains?: string;
  requestRef?: string;
  stepRef?: string;
  expect?: Record<string, unknown>;
  target?: unknown;
  provider?: string;
  configRef?: string;
};

export function summarizeAssertion(a: AssertionSummary, index: number): string {
  const label = a.id ?? `assertion-${index + 1}`;
  if (a.type === "api") {
    const parts: string[] = [];
    if (a.stepRef) parts.push(`step=${a.stepRef}`);
    if (a.requestRef) parts.push(`ref=${a.requestRef}`);
    const exp = a.expect ?? {};
    if (typeof exp.statusCode === "number") parts.push(`HTTP ${exp.statusCode}`);
    if (exp.jsonBody) parts.push(`body≈${JSON.stringify(exp.jsonBody)}`);
    if (typeof exp.requestBodyContains === "string") parts.push(`body∋"${exp.requestBodyContains}"`);
    if (typeof exp.responseBodyContains === "string") {
      parts.push(`resp∋"${exp.responseBodyContains}"`);
    }
    if (exp.responseJsonBody) parts.push(`resp≈${JSON.stringify(exp.responseJsonBody)}`);
    if (exp.responseJsonSchema) parts.push("resp schema");
    return `${label} [API] ${parts.join(" · ") || "（未配置 expect）"}`;
  }
  if (a.type === "db") {
    const exp = a.expect ?? {};
    const parts = [`${a.provider ?? "postgres-readonly"}`, a.configRef].filter(Boolean);
    if (exp.queryRef) parts.push(`query=${String(exp.queryRef)}`);
    if (typeof exp.rowCount === "number") parts.push(`rows=${exp.rowCount}`);
    return `${label} [DB] ${parts.join(" · ")}`;
  }
  if (a.type === "agent") {
    const exp = a.expect ?? {};
    const tools = Array.isArray(exp.toolCalls)
      ? (exp.toolCalls as Array<{ name?: string }>).map((t) => t.name).filter(Boolean)
      : [];
    return `${label} [Agent] ${a.provider ?? "otel-trace"} · ${a.configRef ?? "?"} · tools=${tools.join(",") || "?"}`;
  }
  if (a.type === "ui") {
    const where = a.target ? "（区域）" : "（整页）";
    return `${label} [UI]${where} 包含「${a.contains ?? "…"}」`;
  }
  return `${label} [${a.type ?? "?"}]`;
}

export function failureScreenshotPath(run: {
  runId: string;
  artifacts?: { artifacts?: Array<{ kind: string; path: string }> };
}): string | null {
  const shot = run.artifacts?.artifacts?.find((a) => a.kind === "screenshot");
  if (!shot?.path) return null;
  const name = shot.path.split(/[/\\]/).pop();
  return name ? `/api/runs/${run.runId}/artifacts/${name}` : null;
}

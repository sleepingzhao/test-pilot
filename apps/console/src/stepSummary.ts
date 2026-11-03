type StepLike = {
  action?: string;
  path?: string;
  target?: { role?: string; name?: string; label?: string };
  valueRef?: string;
  key?: string;
};

export function describeStep(step: StepLike, index: number): string {
  const n = index + 1;
  switch (step.action) {
    case "navigate":
      return `${n}. 打开 ${step.path ?? "/"}`;
    case "click":
      return `${n}. 点击「${step.target?.name ?? step.target?.role ?? "元素"}」`;
    case "fill":
      return `${n}. 填写「${step.target?.label ?? step.target?.name ?? "字段"}」${step.valueRef ? "（凭据）" : ""}`;
    case "press":
      return `${n}. 按键 ${step.key ?? "?"}`;
    case "wait":
      return `${n}. 等待${step.target ? "元素出现" : "页面稳定"}`;
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

export function failureScreenshotPath(run: {
  runId: string;
  artifacts?: { artifacts?: Array<{ kind: string; path: string }> };
}): string | null {
  const shot = run.artifacts?.artifacts?.find((a) => a.kind === "screenshot");
  if (!shot?.path) return null;
  const name = shot.path.split(/[/\\]/).pop();
  return name ? `/api/runs/${run.runId}/artifacts/${name}` : null;
}

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

export function failureScreenshotPath(run: {
  runId: string;
  artifacts?: { artifacts?: Array<{ kind: string; path: string }> };
}): string | null {
  const shot = run.artifacts?.artifacts?.find((a) => a.kind === "screenshot");
  if (!shot?.path) return null;
  const name = shot.path.split(/[/\\]/).pop();
  return name ? `/api/runs/${run.runId}/artifacts/${name}` : null;
}

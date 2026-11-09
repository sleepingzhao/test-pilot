import { useState } from "react";
import { moveStep, parseStepJson, removeStepAt, replaceStep, type TestStep } from "@testpilot/test-ir/step-edit";
import { describeStep } from "./stepSummary";

type Props = {
  steps: TestStep[];
  onChange: (steps: TestStep[]) => void;
};

type AddKind = "navigate" | "click" | "fill" | "select" | "wait" | "request";

function nextStepId(steps: TestStep[]): string {
  const max = steps.reduce((acc, step) => {
    const match = /^step-(\d+)$/.exec(step.id);
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 0);
  return `step-${max + 1}`;
}

function templateFor(kind: AddKind, id: string): TestStep {
  switch (kind) {
    case "click":
      return { id, action: "click", target: { role: "button", name: "按钮文案" } };
    case "fill":
      return { id, action: "fill", target: { label: "字段名" }, value: "" };
    case "select":
      return { id, action: "select", target: { label: "下拉框" }, value: "" };
    case "wait":
      return { id, action: "wait", target: { name: "可见文案" } };
    case "request":
      return { id, action: "request", method: "GET", path: "/api/…" };
    default:
      return { id, action: "navigate", path: "/" };
  }
}

export function StepEditorPanel({ steps, onChange }: Props) {
  const [addKind, setAddKind] = useState<AddKind>("navigate");

  const editStepJson = (index: number) => {
    const current = steps[index];
    if (!current) return;
    const raw = window.prompt("编辑步骤 JSON", JSON.stringify(current, null, 2));
    if (raw === null) return;
    const parsed = parseStepJson(raw);
    if (!parsed.ok) {
      window.alert(parsed.error);
      return;
    }
    onChange(replaceStep(steps, index, parsed.step));
  };

  return (
    <section className="review-section">
      <div className="review-section-head">
        <h3>1 · 步骤</h3>
        <span className="review-count">{steps.length} 步</span>
      </div>
      <p className="hint-inline">按顺序执行。可上下移动、编辑 JSON 或删除；试跑与保存都使用此列表。</p>
      {steps.length === 0 && <p className="empty-note">暂无步骤。用下方「添加步骤」或从录制 / 一句话生成。</p>}
      <ul className="step-editor-list">
        {steps.map((step, i) => (
          <li key={`${step.id}-${i}`} className="step-editor-row">
            <span className="step-editor-index">{i + 1}</span>
            <span className="step-editor-summary">{describeStep(step, i).replace(/^\d+\.\s*/, "")}</span>
            <div className="step-editor-actions">
              <button type="button" className="btn-mini" disabled={i === 0} onClick={() => onChange(moveStep(steps, i, -1))}>
                上移
              </button>
              <button
                type="button"
                className="btn-mini"
                disabled={i >= steps.length - 1}
                onClick={() => onChange(moveStep(steps, i, 1))}
              >
                下移
              </button>
              <button type="button" className="btn-mini" onClick={() => editStepJson(i)}>
                编辑
              </button>
              <button type="button" className="btn-mini danger" onClick={() => onChange(removeStepAt(steps, i))}>
                删除
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="step-add-row">
        <select value={addKind} onChange={(e) => setAddKind(e.target.value as AddKind)} aria-label="新步骤类型">
          <option value="navigate">navigate · 打开页面</option>
          <option value="click">click · 点击</option>
          <option value="fill">fill · 填写</option>
          <option value="select">select · 下拉选择</option>
          <option value="wait">wait · 等待元素</option>
          <option value="request">request · 调用接口</option>
        </select>
        <button
          type="button"
          className="btn btn-tertiary btn-small"
          onClick={() => onChange([...steps, templateFor(addKind, nextStepId(steps))])}
        >
          添加步骤
        </button>
      </div>
    </section>
  );
}

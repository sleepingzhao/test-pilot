import { moveStep, parseStepJson, removeStepAt, replaceStep, type TestStep } from "./stepEditor";
import { describeStep } from "./stepSummary";

type Props = {
  steps: TestStep[];
  onChange: (steps: TestStep[]) => void;
};

export function StepEditorPanel({ steps, onChange }: Props) {
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
    <div className="step-editor-box">
      <div className="field">
        <label>步骤（可排序、删除、编辑 JSON）</label>
        <p className="hint-inline">试跑与保存都会使用下方步骤列表；批准仍绑定保存后的 IR hash。</p>
      </div>
      {steps.length === 0 && <p className="hint-inline">暂无步骤，请从录制/intake 生成或手动添加。</p>}
      <ul className="step-editor-list">
        {steps.map((step, i) => (
          <li key={`${step.id}-${i}`} className="step-editor-row">
            <span className="step-editor-summary">{describeStep(step, i)}</span>
            <div className="step-editor-actions">
              <button type="button" className="btn-small" disabled={i === 0} onClick={() => onChange(moveStep(steps, i, -1))}>
                ↑
              </button>
              <button
                type="button"
                className="btn-small"
                disabled={i >= steps.length - 1}
                onClick={() => onChange(moveStep(steps, i, 1))}
              >
                ↓
              </button>
              <button type="button" className="btn-small" onClick={() => editStepJson(i)}>
                编辑
              </button>
              <button type="button" className="btn-small" onClick={() => onChange(removeStepAt(steps, i))}>
                删除
              </button>
            </div>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="btn btn-tertiary btn-small"
        onClick={() =>
          onChange([
            ...steps,
            {
              id: `step-${steps.length + 1}`,
              action: "navigate",
              path: "/",
            },
          ])
        }
      >
        添加 navigate 步骤
      </button>
    </div>
  );
}

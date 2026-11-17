import { useEffect, useState } from "react";
import type { TestActor } from "@testpilot/test-ir";
import { api, type StoredTest } from "./api";
import { loginStepCount, validateActorsJson } from "./actorsReview";

type Props = {
  test: StoredTest;
  actorsJson: string;
  onActorsJsonChange: (next: string) => void;
  visible: boolean;
  onShow: () => void;
  buildIr: () => StoredTest["ir"] | null;
  intentSummary: string;
  onSaved: (test: StoredTest) => void;
  notify: (message: string) => void;
};

const DEFAULT_TWO_ACTORS = `[
  {
    "id": "a",
    "loginSteps": []
  },
  {
    "id": "b",
    "loginSteps": []
  }
]`;

export function ActorsReviewPanel({
  test,
  actorsJson,
  onActorsJsonChange,
  visible,
  onShow,
  buildIr,
  intentSummary,
  onSaved,
  notify,
}: Props) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [parsedPreview, setParsedPreview] = useState<TestActor[] | null>(null);

  useEffect(() => {
    try {
      const raw = JSON.parse(actorsJson) as unknown;
      const v = validateActorsJson(raw);
      setParsedPreview(v.ok ? v.actors : null);
    } catch {
      setParsedPreview(null);
    }
  }, [actorsJson]);

  const saveActors = async () => {
    setSaveError(null);
    let raw: unknown;
    try {
      raw = JSON.parse(actorsJson) as unknown;
    } catch {
      setSaveError("JSON 解析失败");
      return;
    }
    const validated = validateActorsJson(raw);
    if (!validated.ok) {
      setSaveError(validated.error);
      return;
    }
    const ir = buildIr();
    if (!ir) {
      setSaveError("无法生成 IR（请检查断言与步骤）");
      return;
    }
    if (validated.actors.length > 0) ir.actors = validated.actors;
    else delete ir.actors;

    setSaving(true);
    try {
      const saved = await api<StoredTest>(`/api/tests/${test.id}`, {
        method: "PUT",
        body: JSON.stringify({ ir, intentSummary }),
      });
      onSaved(saved);
      notify(saved.approvalStatus === "draft" ? "账号配置已保存，审批已重置为草稿" : "账号配置已保存");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!visible) {
    return (
      <section className="review-section">
        <div className="review-section-head">
          <h3>账号（actors）</h3>
          <span className="review-count">可选</span>
        </div>
        <p className="hint-inline">多浏览器上下文：在 IR 中声明多个 actor，步骤可用 step.actor 指定执行账号。录制侧选择器尚未提供。</p>
        <button
          type="button"
          className="btn btn-tertiary btn-small"
          onClick={() => {
            onShow();
            if (!actorsJson.trim()) onActorsJsonChange(DEFAULT_TWO_ACTORS);
          }}
        >
          配置多账号
        </button>
      </section>
    );
  }

  const list = parsedPreview ?? (test.ir as { actors?: TestActor[] }).actors ?? [];

  return (
    <section className="review-section">
      <div className="review-section-head">
        <h3>账号（actors）</h3>
        <span className="review-count">{list.length} 个</span>
      </div>
      <p className="hint-inline">保存账号配置会单独提交完整 IR（保留当前步骤、断言与 teardown），并将审批重置为草稿。不会试跑或自动批准。</p>
      {list.length > 0 && (
        <ul className="actors-review-list">
          {list.map((actor) => (
            <li key={actor.id} className="actors-review-row">
              <code>{actor.id}</code>
              {actor.id === "primary" ? <span className="badge subtle">主账号</span> : null}
              <span className="hint-inline">登录 {loginStepCount(actor)} 步</span>
            </li>
          ))}
        </ul>
      )}
      <details className="actors-json-details" open>
        <summary>账号配置（JSON）</summary>
        <textarea
          className="actors-json-input"
          rows={12}
          value={actorsJson}
          onChange={(e) => {
            onActorsJsonChange(e.target.value);
            setSaveError(null);
          }}
          spellCheck={false}
          aria-label="actors JSON"
        />
      </details>
      {saveError ? <p className="diagnose-msg">{saveError}</p> : null}
      <div className="actors-review-actions">
        <button type="button" className="btn btn-secondary btn-small" disabled={saving} onClick={() => void saveActors()}>
          {saving ? "保存中…" : "保存账号配置"}
        </button>
      </div>
    </section>
  );
}
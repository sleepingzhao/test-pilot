import { useState } from "react";
import type { StoredRun, StoredTest } from "./api.js";
import { api } from "./api.js";
import { formatJsonBrief, listEvidenceRows } from "./runDetail.js";
import { failureKindLabel, summarizeAssertion } from "./stepSummary.js";

type Target = "demo" | "pilot" | "custom";

type FlowResult = {
  environment: { target: Target; label: string; url: string };
  test: StoredTest;
  generation: {
    uncertainties: string[];
    sources: string[];
    llmUsed: boolean;
    llmTokensUsed: number;
    stepCount: number;
  };
  trial?: { run: StoredRun; trial?: boolean };
  trialError?: string;
};

type Props = {
  demoUrl: string;
  pilotReachable: boolean | null;
  demoReachable: boolean | null;
  pilotIntakeUrl: string | null;
  onRefresh: () => Promise<void>;
  onOpenRun: (runId: string) => void;
};

export function RequirementFlowView({
  demoUrl,
  pilotReachable,
  demoReachable,
  pilotIntakeUrl,
  onRefresh,
  onOpenRun,
}: Props) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [target, setTarget] = useState<Target>("demo");
  const [customUrl, setCustomUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FlowResult | null>(null);
  const [approving, setApproving] = useState(false);

  const runFlow = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await api<FlowResult>("/api/requirement-flow", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim() || undefined,
          text: text.trim(),
          target,
          customUrl: target === "custom" ? customUrl.trim() : undefined,
          channel: "prd",
          autoTrial: true,
        }),
      });
      setResult(res);
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const addToRegression = async () => {
    if (!result?.test || result.trial?.run.status !== "passed") return;
    const ok = window.confirm(
      "试跑通过不等于自动批准。确认你已审阅步骤与断言，并将此用例加入回归？",
    );
    if (!ok) return;
    setApproving(true);
    try {
      const full = await api<StoredTest>(`/api/tests/${result.test.id}`);
      if (!full.irHash) throw new Error("缺少 irHash，请刷新后重试");
      await api(`/api/tests/${result.test.id}/approve`, {
        method: "POST",
        body: JSON.stringify({
          irHash: full.irHash,
          assertionConfigHash: full.currentAssertionConfigHash ?? full.assertionConfigHash,
        }),
      });
      await api("/api/projects/default/runs", {
        method: "POST",
        body: JSON.stringify({ testId: result.test.id }),
      });
      await onRefresh();
      alert("已批准并执行单条回归确认。");
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setApproving(false);
    }
  };

  const trial = result?.trial?.run;

  return (
    <section className="requirement-flow">
      <h2 className="section-title">需求 → 测试</h2>
      <p className="section-lede">
        粘贴本次需求，选择环境，系统生成草案并自动试跑（不计入回归指标）。通过后可一键加入回归——仍需你确认批准。
      </p>

      <div className="card-panel">
        <div className="field">
          <label>用例标题（可选）</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：工单提交成功" />
        </div>
        <div className="field">
          <label>需求 / PRD 片段</label>
          <textarea
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="描述要验证的行为、成功文案、是否需要登录等…"
          />
        </div>
        <fieldset className="env-picker">
          <legend>目标环境</legend>
          <label>
            <input
              type="radio"
              name="env"
              checked={target === "demo"}
              onChange={() => setTarget("demo")}
            />
            练习环境 {demoReachable === false ? "（不可达）" : `(${demoUrl})`}
          </label>
          <label>
            <input
              type="radio"
              name="env"
              checked={target === "pilot"}
              onChange={() => setTarget("pilot")}
              disabled={!pilotIntakeUrl}
            />
            业务试点 {pilotReachable === false ? "（不可达）" : pilotIntakeUrl ? `(${pilotIntakeUrl})` : "（未配置）"}
          </label>
          <label>
            <input
              type="radio"
              name="env"
              checked={target === "custom"}
              onChange={() => setTarget("custom")}
            />
            自定义（须在白名单）
          </label>
          {target === "custom" ? (
            <input
              className="custom-url"
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              placeholder="https://127.0.0.1:…"
            />
          ) : null}
        </fieldset>
        <button
          type="button"
          className="btn btn-primary"
          disabled={loading || !text.trim()}
          onClick={() => void runFlow()}
        >
          {loading ? "生成并试跑…" : "生成草案并试跑"}
        </button>
        {error ? <p className="diagnose-msg">{error}</p> : null}
      </div>

      {result ? (
        <div className="requirement-result">
          <div className="card-panel">
            <h3>生成来源</h3>
            <p className="run-detail-meta">
              {result.environment.label} · {result.environment.url}
            </p>
            <p className="run-detail-meta">
              步骤 {result.generation.stepCount} · 来源 {result.generation.sources.join(", ")}
              {result.generation.llmUsed
                ? ` · LLM ${result.generation.llmTokensUsed} tokens`
                : " · 规则引擎（LLM 未用或已降级）"}
            </p>
            <ul className="diagnose-list">
              {result.generation.uncertainties.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
            <h4>断言草案</h4>
            <ul className="diagnose-list">
              {(result.test.ir.assertions as Array<Record<string, unknown>>).map((a, i) => (
                <li key={i}>{summarizeAssertion(a, i)}</li>
              ))}
            </ul>
          </div>

          <div className="card-panel">
            <h3>试跑报告</h3>
            {result.trialError ? <p className="diagnose-msg">试跑失败：{result.trialError}</p> : null}
            {trial ? (
              <>
                <p className="run-detail-meta">
                  {trial.status === "passed" ? "通过" : "失败"}
                  {failureKindLabel(trial.metrics?.failureKind)
                    ? ` · ${failureKindLabel(trial.metrics?.failureKind)}`
                    : ""}
                  · {trial.metrics?.durationMs ?? "—"} ms
                </p>
                <ol className="run-step-timeline">
                  {trial.steps.map((s) => (
                    <li key={s.stepId} className={`run-step${s.status === "failed" ? " run-step-failed" : ""}`}>
                      <span>{s.stepId}</span>
                      <span>{s.status}</span>
                      {s.message ? <span className="run-step-msg">{s.message}</span> : null}
                    </li>
                  ))}
                </ol>
                <ul className="run-assertion-list">
                  {trial.assertions.map((a) => (
                    <li key={a.assertionId}>
                      <strong>{a.assertionId}</strong> {a.passed ? "通过" : "失败"}
                      {a.message ? <p className="diagnose-msg">{a.message}</p> : null}
                      {a.expected !== undefined && (
                        <pre className="assert-pre">{formatJsonBrief(a.expected, 240)}</pre>
                      )}
                      {a.actual !== undefined && (
                        <pre className="assert-pre">{formatJsonBrief(a.actual, 240)}</pre>
                      )}
                    </li>
                  ))}
                </ul>
                <ul className="evidence-links">
                  {listEvidenceRows(trial).map((row) => (
                    <li key={row.label}>
                      <span>{row.label}</span>
                      {row.href ? (
                        <a className="btn-small" href={row.href} target="_blank" rel="noreferrer">
                          打开
                        </a>
                      ) : (
                        <span className="evidence-missing">未生成</span>
                      )}
                    </li>
                  ))}
                </ul>
                <button type="button" className="btn-small" onClick={() => onOpenRun(trial.runId)}>
                  完整运行详情
                </button>
              </>
            ) : (
              !result.trialError && <p className="hint-inline">未执行试跑</p>
            )}
            {trial?.status === "passed" ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={approving}
                onClick={() => void addToRegression()}
              >
                {approving ? "批准中…" : "一键加入回归"}
              </button>
            ) : (
              <p className="stat-note">试跑未通过时请先改草案或环境，不会自动批准。</p>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

import { useEffect, useState } from "react";
import type { DetectionRecord, StoredRun, StoredTest } from "./api.js";
import { api } from "./api.js";
import { CAPABILITY_LABELS } from "./capabilityLabels";
import { ConfirmDialog } from "./ConfirmDialog";
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
  onOpenReview: (testId: string) => void;
  onOpenProfile: () => void;
};

export function RequirementFlowView({
  demoUrl,
  pilotReachable,
  demoReachable,
  pilotIntakeUrl,
  onRefresh,
  onOpenRun,
  onOpenReview,
  onOpenProfile,
}: Props) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [target, setTarget] = useState<Target>("demo");
  const [customUrl, setCustomUrl] = useState("");
  const [detected, setDetected] = useState<DetectionRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FlowResult | null>(null);
  const [approving, setApproving] = useState(false);
  const [approvedRun, setApprovedRun] = useState<StoredRun | null>(null);
  const [confirmApprove, setConfirmApprove] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetected(null);
    const params = new URLSearchParams({ target });
    api<{ record: DetectionRecord | null }>(`/api/detect/latest?${params.toString()}`)
      .then((res) => {
        if (!cancelled) setDetected(res.record);
      })
      .catch(() => {
        if (!cancelled) setDetected(null);
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  const runFlow = async () => {
    setLoading(true);
    setError(null);
    setStage("排队中");
    setElapsed(0);
    if (result?.test && result.test.approvalStatus !== "approved") {
      await api(`/api/tests/${result.test.id}`, { method: "DELETE" }).catch(() => undefined);
    }
    setResult(null);
    setApprovedRun(null);
    const startedAt = Date.now();
    try {
      const { jobId } = await api<{ jobId: string }>("/api/requirement-flow/jobs", {
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
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const job = await api<{
          status: "running" | "completed" | "failed";
          stage: string;
          result?: FlowResult;
          error?: string;
        }>(`/api/requirement-flow/jobs/${jobId}`);
        setStage(job.stage);
        setElapsed(Math.round((Date.now() - startedAt) / 1000));
        if (job.status === "completed" && job.result) {
          setResult(job.result);
          await onRefresh();
          break;
        }
        if (job.status === "failed") {
          throw new Error(job.error ?? "生成失败");
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setStage(null);
    }
  };

  const addToRegression = () => {
    if (!result?.test || result.trial?.run.status !== "passed") return;
    setConfirmApprove(true);
  };

  const confirmAddToRegression = async () => {
    setConfirmApprove(false);
    if (!result?.test || result.trial?.run.status !== "passed") return;
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
      const runRes = await api<{ runs?: StoredRun[]; async?: boolean }>(
        "/api/projects/default/runs",
        {
          method: "POST",
          body: JSON.stringify({ testId: result.test.id }),
        },
      );
      const run = runRes.runs?.[0] ?? null;
      setApprovedRun(run);
      setResult((prev) =>
        prev ? { ...prev, test: { ...prev.test, approvalStatus: "approved" } } : prev,
      );
      await onRefresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setApproving(false);
    }
  };

  const trial = result?.trial?.run;

  return (
    <section className="requirement-flow">
      <div className="card-panel">
        <div className="field">
          <label htmlFor="requirement-title">用例标题（可选）</label>
          <input
            id="requirement-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：工单提交成功"
          />
        </div>
        <div className="field">
          <label htmlFor="requirement-text">需求 / PRD 片段</label>
          <textarea
            id="requirement-text"
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
        <div className="detected-capabilities">
          <span className="stat-label">环境能力</span>
          {detected ? (
            <>
              {detected.profile.capabilities.length > 0 ? (
                detected.profile.capabilities.slice(0, 6).map((capability) => (
                  <span className="badge" key={capability.id}>
                    {CAPABILITY_LABELS[capability.id] ?? capability.id} ·{" "}
                    {Math.round(capability.confidence * 100)}%
                  </span>
                ))
              ) : (
                <span className="stat-note">未识别到明确能力</span>
              )}
              <button type="button" className="link-button" onClick={onOpenProfile}>
                查看系统画像
              </button>
            </>
          ) : (
            <span className="stat-note">
              尚未探测；
              <button type="button" className="link-button" onClick={onOpenProfile}>
                先做系统画像
              </button>
            </span>
          )}
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={loading || !text.trim()}
          onClick={() => void runFlow()}
        >
          {loading ? "生成中…" : "生成草案并试跑"}
        </button>
        {loading ? (
          <div className="flow-progress" role="status" aria-live="polite">
            <div className="flow-progress-track">
              <span />
            </div>
            <p className="flow-progress-stage">
              {stage ?? "处理中"}… <span>{elapsed}s</span>
            </p>
            <p className="stat-note">生成与自动试跑通常需要 20–90 秒；阶段会实时更新。</p>
          </div>
        ) : null}
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
              {result.generation.uncertainties.slice(0, 3).map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
            {result.generation.uncertainties.length > 3 ? (
              <details className="uncertainty-more">
                <summary>还有 {result.generation.uncertainties.length - 3} 条生成说明</summary>
                <ul className="diagnose-list">
                  {result.generation.uncertainties.slice(3).map((u) => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            <h4>断言草案</h4>
            <ul className="diagnose-list">
              {(result.test.ir.assertions as Array<Record<string, unknown>>).map((a, i) => (
                <li key={i}>{summarizeAssertion(a, i)}</li>
              ))}
            </ul>
            <div className="flow-actions">
              <button type="button" className="btn-small" onClick={() => onOpenReview(result.test.id)}>
                打开审阅编辑
              </button>
              <button type="button" className="btn-small" disabled={loading} onClick={() => void runFlow()}>
                重新生成
              </button>
            </div>
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
                      {s.message ? (
                        s.message.length > 200 ? (
                          <details className="run-step-more">
                            <summary>{s.message.slice(0, 200)}…</summary>
                            <pre>{s.message}</pre>
                          </details>
                        ) : (
                          <span className="run-step-msg">{s.message}</span>
                        )
                      ) : null}
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
            {result.test.approvalStatus === "approved" ? (
              <div className="flow-approved">
                <p className="run-detail-meta">
                  已加入回归
                  {approvedRun
                    ? ` · 确认跑${approvedRun.status === "passed" ? "通过" : "失败"} · ${
                        approvedRun.metrics?.durationMs ?? "—"
                      } ms`
                    : ""}
                </p>
                {approvedRun ? (
                  <button type="button" className="btn-small" onClick={() => onOpenRun(approvedRun.runId)}>
                    看确认跑详情
                  </button>
                ) : null}
              </div>
            ) : trial?.status === "passed" ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={approving}
                onClick={() => void addToRegression()}
              >
                {approving ? "批准中…" : "一键加入回归"}
              </button>
            ) : (
              <p className="stat-note">
                试跑未通过时不会自动批准；可先打开审阅编辑，或修改需求后重新生成。
              </p>
            )}
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmApprove}
        title="加入回归？"
        body="试跑通过不等于自动批准。确认你已审阅步骤与断言后，将此用例加入回归。"
        confirmLabel="加入回归"
        onCancel={() => setConfirmApprove(false)}
        onConfirm={() => void confirmAddToRegression()}
      />
    </section>
  );
}

import { useEffect, useState } from "react";
import { api, type StoredRun } from "./api.js";
import { formatJsonBrief, listEvidenceRows, runDetailHeadline } from "./runDetail.js";
import { failureKindLabel } from "./stepSummary.js";

type Props = {
  runId: string;
  onBack: () => void;
  onOpenBatch?: (batchId: string) => void;
};

type BatchSummary = {
  batchId: string;
  startedAt: string;
  total: number;
  passed: number;
  status: string;
};

export function RunDetailView({ runId, onBack, onOpenBatch }: Props) {
  const [run, setRun] = useState<StoredRun | null>(null);
  const [batch, setBatch] = useState<BatchSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setError(null);
      setRun(null);
      setBatch(null);
      try {
        const detail = await api<StoredRun>(`/api/runs/${runId}`);
        if (cancelled) return;
        setRun(detail);
        if (detail.batchId) {
          try {
            const res = await api<{ batch: BatchSummary }>(`/api/batches/${detail.batchId}`);
            if (!cancelled) setBatch(res.batch);
          } catch {
            /* batch may have been cleaned */
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (error) {
    return (
      <section>
        <button type="button" className="btn btn-secondary btn-back" onClick={onBack}>
          ← 返回
        </button>
        <p className="diagnose-msg">{error}</p>
      </section>
    );
  }

  if (!run) {
    return (
      <section>
        <button type="button" className="btn btn-secondary btn-back" onClick={onBack}>
          ← 返回
        </button>
        <p className="hint-inline">加载运行详情…</p>
      </section>
    );
  }

  const evidence = listEvidenceRows(run);

  return (
    <section className="run-detail">
      <button type="button" className="btn btn-secondary btn-back" onClick={onBack}>
        ← 返回
      </button>
      <header className="run-detail-head">
        <h2 className="section-title">{run.testTitle}</h2>
        <p className="run-detail-meta">
          {runDetailHeadline(run)}
          {run.trial ? " · 试跑" : ""}
        </p>
        <p className="run-detail-meta">
          {new Date(run.completedAt).toLocaleString()} · <code>{run.runId}</code>
        </p>
        {run.batchId && (
          <p className="run-detail-meta">
            批次{" "}
            {onOpenBatch ? (
              <button type="button" className="link-button" onClick={() => onOpenBatch(run.batchId!)}>
                {run.batchId}
              </button>
            ) : (
              <code>{run.batchId}</code>
            )}
            {batch ? ` · ${batch.passed}/${batch.total} 通过 · ${batch.status}` : null}
          </p>
        )}
        {run.metrics?.failureKind && (
          <p className="run-detail-kind">
            失败分型：<strong>{failureKindLabel(run.metrics.failureKind) ?? run.metrics.failureKind}</strong>
          </p>
        )}
      </header>

      <div className="run-detail-grid">
        <div className="card-panel">
          <h3>步骤时间线</h3>
          <ol className="run-step-timeline">
            {run.steps.map((s) => (
              <li
                key={s.stepId}
                className={`run-step${s.status === "failed" ? " run-step-failed" : ""}`}
              >
                <span className="run-step-id">{s.stepId}</span>
                <span className="run-step-status">{s.status}</span>
                {typeof s.durationMs === "number" ? (
                  <span className="run-step-dur">{s.durationMs} ms</span>
                ) : null}
                {s.message ? <span className="run-step-msg">{s.message}</span> : null}
              </li>
            ))}
            {run.steps.length === 0 && <li className="run-step-muted">无步骤记录</li>}
          </ol>
        </div>

        <div className="card-panel">
          <h3>断言</h3>
          <ul className="run-assertion-list">
            {run.assertions.map((a) => (
              <li key={a.assertionId} className={a.passed ? "assert-pass" : "assert-fail"}>
                <div className="run-assertion-head">
                  <strong>{a.assertionId}</strong>
                  <span>{a.passed ? "通过" : "失败"}</span>
                  {a.errorKind ? <span className="assert-kind">{a.errorKind}</span> : null}
                </div>
                {a.message ? <p className="diagnose-msg">{a.message}</p> : null}
                {a.expected !== undefined && (
                  <details className="assert-detail">
                    <summary>预期（已脱敏）</summary>
                    <pre>{formatJsonBrief(a.expected)}</pre>
                  </details>
                )}
                {a.actual !== undefined && (
                  <details className="assert-detail" open={!a.passed}>
                    <summary>实际（已脱敏）</summary>
                    <pre>{formatJsonBrief(a.actual)}</pre>
                  </details>
                )}
              </li>
            ))}
            {run.assertions.length === 0 && <li className="run-step-muted">无断言结果</li>}
          </ul>
        </div>

        <div className="card-panel run-detail-evidence">
          <h3>证据</h3>
          <ul className="evidence-links">
            {evidence.map((row) => (
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
        </div>
      </div>
    </section>
  );
}

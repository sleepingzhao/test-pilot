import { useEffect, useState } from "react";
import { api, type StoredBatch, type StoredRun } from "./api.js";
import { failureKindLabel } from "./stepSummary.js";

type Props = {
  batchId: string;
  onBack: () => void;
  onOpenRun: (run: StoredRun) => void;
};

function durationMs(batch: StoredBatch): number {
  const start = Date.parse(batch.startedAt);
  const end = Date.parse(batch.completedAt ?? new Date().toISOString());
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

export function BatchDetailView({ batchId, onBack, onOpenRun }: Props) {
  const [batch, setBatch] = useState<StoredBatch | null>(null);
  const [runs, setRuns] = useState<StoredRun[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setError(null);
      setBatch(null);
      setRuns([]);
      try {
        const res = await api<{ batch: StoredBatch; runs: StoredRun[] }>(`/api/batches/${batchId}`);
        if (cancelled) return;
        setBatch(res.batch);
        setRuns(res.runs);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [batchId]);

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

  if (!batch) {
    return (
      <section>
        <button type="button" className="btn btn-secondary btn-back" onClick={onBack}>
          ← 返回
        </button>
        <p className="hint-inline">加载批次…</p>
      </section>
    );
  }

  const elapsed = durationMs(batch);
  return (
    <section className="run-detail">
      <button type="button" className="btn btn-secondary btn-back" onClick={onBack}>
        ← 返回
      </button>
      <header className="run-detail-head">
        <h2 className="section-title">批次 {batch.batchId}</h2>
        <p className="run-detail-meta">
          {new Date(batch.startedAt).toLocaleString()} · {batch.passed}/{batch.total} 通过 ·{" "}
          {Math.round(elapsed / 1000)}s
          {batch.status === "running" ? " · 运行中" : batch.status === "failed" ? " · 批次失败" : ""}
          {batch.mode ? ` · ${batch.mode === "full" ? "全量已批准" : batch.mode === "selected" ? "指定用例" : "含草稿"}` : ""}
          {batch.repeatCount && batch.repeatCount > 1 ? ` · 重复 ${batch.repeatCount}` : ""}
        </p>
        {batch.error ? <p className="diagnose-msg">{batch.error}</p> : null}
        {batch.artifactBytesTotal != null ? (
          <p className="run-detail-meta">证据约 {(batch.artifactBytesTotal / 1024 / 1024).toFixed(1)} MB</p>
        ) : null}
      </header>

      <div className="list">
        {runs.map((run) => (
          <div className="row" key={run.runId}>
            <div className="row-main">
              <h3>
                {run.testTitle}
                {run.trial ? <span className="badge trial">试跑</span> : null}
              </h3>
              <p>
                {new Date(run.completedAt).toLocaleString()} · {run.metrics?.durationMs ?? "—"} ms
                {(run.metrics?.attemptCount ?? 1) > 1
                  ? ` · ${run.metrics?.attemptCount} 次尝试${run.metrics?.flakeRecovery ? "（flake 恢复）" : ""}`
                  : ""}
                {failureKindLabel(run.metrics?.failureKind)
                  ? ` · ${failureKindLabel(run.metrics?.failureKind)}`
                  : ""}
              </p>
            </div>
            <div className="row-actions">
              <span className={`status-pill ${run.status === "passed" ? "pass" : "fail"}`}>
                {run.status === "passed" ? "通过" : run.status === "error" ? "错误" : "失败"}
              </span>
              <button type="button" className="btn-small" onClick={() => onOpenRun(run)}>
                详情
              </button>
            </div>
          </div>
        ))}
        {runs.length === 0 && <p className="section-lede">该批次还没有已落盘的运行记录。</p>}
      </div>
    </section>
  );
}

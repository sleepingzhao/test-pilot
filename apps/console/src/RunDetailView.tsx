import { useEffect, useState } from "react";
import { api, type StoredRun, type WsLog } from "./api.js";
import {
  artifactUrlForFile,
  formatJsonBrief,
  listActorEvidenceGroups,
  listEvidenceRows,
  runDetailHeadline,
} from "./runDetail.js";
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

function shouldLoadWsLog(run: StoredRun): boolean {
  if (run.artifactsPresent?.ws === false) return false;
  return run.artifacts.artifacts.some((a) => a.kind === "ws") || run.artifactsPresent?.ws === true;
}

function wsPayloadPreview(payload: string, max = 240): string {
  return payload.length > max ? `${payload.slice(0, max)}…` : payload;
}

export function RunDetailView({ runId, onBack, onOpenBatch }: Props) {
  const [run, setRun] = useState<StoredRun | null>(null);
  const [batch, setBatch] = useState<BatchSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wsLog, setWsLog] = useState<WsLog | "loading" | null>(null);

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

  useEffect(() => {
    if (!run || !shouldLoadWsLog(run)) {
      setWsLog(null);
      return;
    }
    let cancelled = false;
    setWsLog("loading");
    void (async () => {
      try {
        const res = await api<{ ws: WsLog }>(`/api/runs/${run.runId}/ws`);
        if (!cancelled) {
          setWsLog(res.ws.frames.length === 0 && res.ws.dropped === 0 ? null : res.ws);
        }
      } catch {
        if (!cancelled) setWsLog(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [run]);

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
  const actorEvidence = listActorEvidenceGroups(run);
  const hasFailedStep = run.steps.some((s) => s.status === "failed");
  const hasFailedAssertion = run.assertions.some((a) => !a.passed);

  function scrollToFailure() {
    const failedStep = document.querySelector(".run-step-failed");
    if (failedStep) {
      failedStep.scrollIntoView({ block: "center" });
      return;
    }
    if (hasFailedAssertion) {
      document.getElementById("run-assertions-panel")?.scrollIntoView({ block: "start" });
    }
  }

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
          {run.actorMode === "multi" ? (
            <>
              {" · "}
              <span className="badge subtle">多账号执行</span>
            </>
          ) : null}
          {run.readOnly ? (
            <>
              {" · "}
              <span className="badge subtle">只读执行</span>
            </>
          ) : null}
          {run.readOnlyBlockedRequests ? (
            <>
              {" · "}
              <span className="badge warn">已阻止 {run.readOnlyBlockedRequests} 个写请求</span>
            </>
          ) : null}
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
        {(hasFailedStep || hasFailedAssertion) && (
          <p className="run-detail-actions">
            <button type="button" className="btn btn-secondary btn-small" onClick={scrollToFailure}>
              跳到失败步骤
            </button>
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
                id={`run-step-${s.stepId}`}
                className={`run-step${s.status === "failed" ? " run-step-failed" : ""}`}
              >
                <span className="run-step-id">{s.stepId}</span>
                {s.actor ? (
                  <span className="badge subtle step-actor-badge" title="step.actor">
                    {s.actor}
                  </span>
                ) : null}
                <span className="run-step-status">{s.status}</span>
                {typeof s.durationMs === "number" ? (
                  <span className="run-step-dur">{s.durationMs} ms</span>
                ) : null}
                {s.screenshot ? (
                  <a
                    className="run-step-shot-link"
                    href={artifactUrlForFile(run, s.screenshot)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <img
                      className="run-step-shot"
                      src={artifactUrlForFile(run, s.screenshot)}
                      alt={`${s.stepId} 截图`}
                      loading="lazy"
                    />
                  </a>
                ) : null}
                {s.message ? (
                  s.message.length > 240 ? (
                    <details className="run-step-more">
                      <summary>{s.message.slice(0, 240)}…</summary>
                      <pre>{s.message}</pre>
                    </details>
                  ) : (
                    <span className="run-step-msg">{s.message}</span>
                  )
                ) : null}
              </li>
            ))}
            {run.steps.length === 0 && <li className="run-step-muted">无步骤记录</li>}
          </ol>
        </div>

        <div className="card-panel" id="run-assertions-panel">
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

        {run.cleanup ? (
          <div className="card-panel">
            <h3>清理</h3>
            <p className="run-detail-meta">
              状态：
              <strong>
                {run.cleanup.status === "passed"
                  ? "通过"
                  : run.cleanup.status === "failed"
                    ? "失败"
                    : run.cleanup.steps.length === 0
                      ? "未配置清理"
                      : "已跳过"}
              </strong>
              {run.cleanup.errorKind ? ` · ${run.cleanup.errorKind}` : ""}
            </p>
            {run.cleanup.message ? <p className="diagnose-msg">{run.cleanup.message}</p> : null}
            <ol className="run-step-timeline">
              {run.cleanup.steps.map((s) => (
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
              {run.cleanup.steps.length === 0 && run.cleanup.status === "skipped" ? (
                <li className="run-step-muted">未配置清理</li>
              ) : null}
            </ol>
          </div>
        ) : null}

        {wsLog !== null ? (
          <div className="card-panel run-detail-ws">
            <h3>WebSocket 帧</h3>
            {wsLog === "loading" ? (
              <p className="hint-inline">加载 WebSocket 帧…</p>
            ) : (
              <>
                {(() => {
                  const sent = wsLog.frames.filter((f) => f.direction === "sent").length;
                  const recv = wsLog.frames.filter((f) => f.direction === "received").length;
                  const parts = [`发送 ${sent}`, `接收 ${recv}`];
                  if (wsLog.dropped > 0) parts.push(`丢弃 ${wsLog.dropped}`);
                  parts.push(`上限 ${wsLog.limit}`);
                  return <p className="run-detail-meta ws-frame-summary">{parts.join(" · ")}</p>;
                })()}
                {wsLog.note ? <p className="stat-note">{wsLog.note}</p> : null}
                <p className="stat-note">帧内容已按证据规则脱敏</p>
                {wsLog.frames.length === 0 ? (
                  <p className="run-step-muted">本次运行没有采集到 WebSocket 帧</p>
                ) : (
                  <ol className="ws-frame-list">
                    {wsLog.frames.map((frame, index) => (
                      <li key={`${frame.at}-${frame.direction}-${index}`} className="ws-frame-row">
                        <div className="ws-frame-head">
                          <span
                            className={`ws-dir-badge ws-dir-${frame.direction === "sent" ? "out" : "in"}`}
                          >
                            {frame.direction === "sent" ? "发送" : "接收"}
                          </span>
                          <span className="ws-frame-time">
                            {new Date(frame.at).toLocaleTimeString()}
                          </span>
                          <span className="ws-frame-size">{frame.size} B</span>
                          <span className="ws-frame-url" title={frame.url}>
                            {frame.url}
                          </span>
                        </div>
                        {frame.payload.length > 240 ? (
                          <details className="ws-frame-payload">
                            <summary>
                              <pre className="ws-payload-pre">{wsPayloadPreview(frame.payload)}</pre>
                            </summary>
                            <pre className="ws-payload-pre">{frame.payload}</pre>
                          </details>
                        ) : (
                          <pre className="ws-payload-pre">{frame.payload}</pre>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
          </div>
        ) : null}

        {actorEvidence.length > 0 ? (
          <div className="card-panel run-detail-actor-evidence">
            <h3>账号证据</h3>
            <p className="hint-inline">按 actor 分组的附属浏览器上下文证据（路径 actors/&lt;id&gt;/）。</p>
            {actorEvidence.map((group) => (
              <div key={group.actorId} className="actor-evidence-group">
                <h4>
                  <code>{group.actorId}</code>
                </h4>
                <ul className="evidence-links">
                  {group.links.map((link) => (
                    <li key={link.href}>
                      <span>{link.label}</span>
                      <a className="btn-small" href={link.href} target="_blank" rel="noreferrer">
                        打开
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : null}

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

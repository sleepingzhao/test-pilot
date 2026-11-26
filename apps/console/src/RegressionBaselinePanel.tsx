import { useState } from "react";
import type { RegressionBaselinesResponse } from "./api";

type Props = {
  baseline: RegressionBaselinesResponse | null;
  onOpenBatch: (batchId: string) => void;
};

function minutes(value: number | null): string {
  return value === null ? "待测" : `${value.toLocaleString()} 分钟`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} 秒`;
}

export function RegressionBaselinePanel({ baseline, onOpenBatch }: Props) {
  const [selectedKey, setSelectedKey] = useState("");
  const reports = baseline?.reports ?? [];
  const suite = reports.find(report => report.suiteKey === selectedKey) ?? reports[0];

  return (
    <section className="batch-trend baseline-panel" aria-label="套件回归基线">
      <h3 className="batch-trend-title">套件回归基线</h3>
      {suite ? (
        <>
          {reports.length > 1 && (
            <div className="field">
              <label htmlFor="regression-baseline-suite">套件与执行配置</label>
              <select id="regression-baseline-suite" value={suite.suiteKey} onChange={e => setSelectedKey(e.target.value)}>
                {reports.map(report => (
                  <option key={report.suiteKey} value={report.suiteKey}>
                    {report.testIds.length} 条 · {report.batchCount}/3 批 · {new Date(report.batches[0]!.startedAt).toLocaleString()} · {report.suiteKey.slice(0, 8)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <p className="stat-note">
            {suite.testIds.length} 条用例 · {suite.batchCount}/3 批 · {suite.maxParallel === undefined ? "历史并发未记录" : `并发上限 ${suite.maxParallel}`}
          </p>
          {suite.batchCount === 3 ? (
            <p className="flake-lede">
              通过率 {Math.round(suite.aggregate.passRate * 100)}%（目标 ≥
              {Math.round((baseline?.targets.passRateMin ?? 0.95) * 100)}%
              {suite.aggregate.meetsPassTarget ? " ✓" : " ✗"}）· Flake {Math.round(suite.aggregate.flakeRate * 100)}%（目标 &lt;
              {Math.round((baseline?.targets.flakeRateMax ?? 0.05) * 100)}%
              {suite.aggregate.meetsFlakeTarget ? " ✓" : " ✗"}）
            </p>
          ) : <p className="stat-note">还需 {3 - suite.batchCount} 批相同套件与执行配置的回归。</p>}
          <p className="flake-lede">自动执行总耗时（墙钟） {seconds(suite.aggregate.durationMs)}</p>
          <ul className="batch-trend-list">
            {suite.batches.map(batch => (
              <li key={batch.batchId}>
                <button type="button" className="link-button" onClick={() => onOpenBatch(batch.batchId)}>
                  {new Date(batch.startedAt).toLocaleString()}
                </button>
                <span className={batch.passed === batch.total ? "batch-ok" : "batch-warn"}>{batch.passed}/{batch.total}</span>
                <span className="batch-dur">{seconds(batch.durationMs)}</span>
              </li>
            ))}
          </ul>
          <dl className="baseline-human">
            <dt>纯手工回归</dt><dd>{minutes(suite.human.manualRegressionMinutes)}</dd>
            <dt>审阅和排错</dt><dd>{minutes(suite.human.reviewAndTriageMinutes)}</dd>
            <dt>剩余手工检查</dt><dd>{minutes(suite.human.remainingManualMinutes)}</dd>
            <dt>每轮人工净节省</dt><dd>{minutes(suite.human.minutesSaved)}</dd>
          </dl>
          <details className="baseline-scope">
            <summary>查看套件用例与计时标识</summary>
            <p className="stat-note">{suite.testIds.join("、")}</p>
            <code>{suite.suiteKey}</code>
          </details>
        </>
      ) : <p className="stat-note">尚无可比较批次。运行同一组已批准用例三次后显示基线。</p>}
    </section>
  );
}

import { useEffect, useState } from "react";
import type { RouteCoverageRow, RouteEvidence } from "@testpilot/detect";
import { api, type StoredTest } from "./api";
import { summarizeAssertion } from "./stepSummary";

const columns: Array<[RouteEvidence["kind"], string]> = [
  ["route", "路由可达"], ["list", "列表数量"], ["searchMatch", "搜索命中"],
  ["searchFilter", "搜索过滤"], ["detail", "所选记录详情"],
];

export function BusinessCoveragePanel({ detectionId, tests, onOpenReview }: {
  detectionId: string;
  tests: StoredTest[];
  onOpenReview: (testId: string) => void;
}) {
  const [rows, setRows] = useState<RouteCoverageRow[]>([]);
  const [status, setStatus] = useState("正在读取断言…");
  useEffect(() => {
    let active = true;
    api<RouteCoverageRow[]>(`/api/detect/${detectionId}/business-coverage`)
      .then(rows => {
        if (!active) return;
        setRows(rows);
        setStatus(rows.length ? "" : "本次画像没有页面记录。");
      })
      .catch(() => { if (active) setStatus("读取业务覆盖失败。"); });
    return () => { active = false; };
  }, [detectionId, tests]);

  return (
    <section className="card-panel business-coverage" aria-label="业务覆盖">
      <h3>业务覆盖</h3>
      <p className="stat-note">按页面汇总已批准用例的 UI 断言。展开可查看判定条件和来源用例。</p>
      {status ? <p role="status">{status}</p> : (
        <div className="coverage-scroll">
          <table>
            <thead><tr><th scope="col">页面</th>{columns.map(([kind, label]) => <th scope="col" key={kind}>{label}</th>)}</tr></thead>
            <tbody>{rows.map(row => (
              <tr key={row.route}>
                <th scope="row"><code>{row.route}</code></th>
                {columns.map(([kind, label]) => {
                  const refs = row.evidence.filter(ref => ref.kind === kind);
                  return (
                    <td key={kind}>{refs.length ? (
                      <details>
                        <summary aria-label={`${row.route} ${label}，${refs.length} 条断言`}>{refs.length} 条断言</summary>
                        <ul>{refs.map(ref => (
                          <li key={`${ref.testId}-${ref.index}`}>
                            <span>{summarizeAssertion(ref.assertion, ref.index)}</span>
                            <button className="link-button" type="button" onClick={() => onOpenReview(ref.testId)}>{ref.title}</button>
                          </li>
                        ))}</ul>
                      </details>
                    ) : <span className="stat-note">未覆盖</span>}</td>
                  );
                })}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

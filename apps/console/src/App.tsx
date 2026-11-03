import { useCallback, useEffect, useState } from "react";
import { api, type StoredRun, type StoredTest } from "./api";

type View = "home" | "tests" | "record" | "history";

export function App() {
  const [view, setView] = useState<View>("home");
  const [tests, setTests] = useState<StoredTest[]>([]);
  const [runs, setRuns] = useState<StoredRun[]>([]);
  const [lastByTest, setLastByTest] = useState<Record<string, StoredRun>>({});
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [editTest, setEditTest] = useState<StoredTest | null>(null);
  const [assertionText, setAssertionText] = useState("");
  const [recordTitle, setRecordTitle] = useState("");
  const [recordJob, setRecordJob] = useState<string | null>(null);
  const [summary, setSummary] = useState<{
    passRate: number;
    avgDurationMs: number;
    runCount: number;
    lastBatchDurationMs?: number | null;
    pilotBaselineMinutes?: number | null;
  } | null>(null);
  const [demoOk, setDemoOk] = useState<boolean | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ completed: number; total: number; title?: string } | null>(
    null,
  );

  const notify = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4500);
  };

  const refresh = useCallback(async () => {
    const t = await api<StoredTest[]>("/api/projects/default/tests");
    setTests(t);
    try {
      const r = await api<StoredRun[]>("/api/runs");
      setRuns(r);
      const map: Record<string, StoredRun> = {};
      for (const run of r) {
        if (!map[run.testId] || run.startedAt > map[run.testId].startedAt) map[run.testId] = run;
      }
      setLastByTest(map);
    } catch {
      setRuns([]);
    }
    try {
      const m = await api<{
        passRate: number;
        avgDurationMs: number;
        runCount: number;
        lastBatchDurationMs?: number | null;
        pilotBaselineMinutes?: number | null;
      }>("/api/metrics/summary");
      setSummary(m);
    } catch {
      setSummary(null);
    }
    try {
      const env = await api<{ demoReachable: boolean; demoUrl: string }>("/api/environment");
      setDemoOk(env.demoReachable);
    } catch {
      setDemoOk(null);
    }
  }, []);

  useEffect(() => {
    refresh().catch((e) => notify(String(e)));
  }, [refresh]);

  useEffect(() => {
    if (!recordJob) return;
    const timer = setInterval(async () => {
      const job = await api<{ status: string; error?: string }>(`/api/record/${recordJob}`);
      if (job.status === "running") return;
      clearInterval(timer);
      setRecordJob(null);
      if (job.status === "completed") {
        notify("录制已保存，请补充断言并批准");
        setView("tests");
        await refresh();
      } else notify(job.error ?? "录制失败");
    }, 1500);
    return () => clearInterval(timer);
  }, [recordJob, refresh]);

  const pollBatch = async (jobId: string) => {
    for (;;) {
      const job = await api<{
        status: string;
        completed: number;
        total: number;
        currentTitle?: string;
        runs: StoredRun[];
        error?: string;
      }>(`/api/batch-runs/${jobId}`);
      setBatchProgress({ completed: job.completed, total: job.total, title: job.currentTitle });
      if (job.status === "running") {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      setBatchProgress(null);
      if (job.status === "failed") throw new Error(job.error ?? "批量运行失败");
      const passed = job.runs.filter((r) => r.status === "passed").length;
      notify(`回归完成：${passed}/${job.runs.length} 通过`);
      await refresh();
      return;
    }
  };

  const runAll = async () => {
    setLoading(true);
    try {
      const res = await api<{ async?: boolean; jobId?: string; total?: number; runs?: StoredRun[] }>(
        "/api/projects/default/runs",
        { method: "POST", body: JSON.stringify({}) },
      );
      if (res.async && res.jobId) {
        setBatchProgress({ completed: 0, total: res.total ?? 0 });
        await pollBatch(res.jobId);
      } else {
        const rs = res.runs ?? [];
        const passed = rs.filter((r) => r.status === "passed").length;
        notify(`回归完成：${passed}/${rs.length} 通过`);
        await refresh();
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setBatchProgress(null);
    }
  };

  const runOne = async (id: string) => {
    setLoading(true);
    try {
      await api("/api/projects/default/runs", { method: "POST", body: JSON.stringify({ testId: id }) });
      notify("执行完成");
      await refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const openEdit = (t: StoredTest) => {
    setEditTest(t);
    const a = t.ir.assertions?.[0] as { contains?: string } | undefined;
    setAssertionText(a?.contains ?? "");
  };

  const applySuggest = async () => {
    if (!editTest) return;
    const { assertions } = await api<{ assertions: StoredTest["ir"]["assertions"] }>(
      `/api/tests/${editTest.id}/suggest-assertions`,
      { method: "POST", body: "{}" },
    );
    const contains = (assertions[0] as { contains?: string })?.contains ?? "";
    setAssertionText(contains);
    notify("已填入建议断言，确认后保存并批准");
  };

  const saveAndApprove = async () => {
    if (!editTest) return;
    const ir = {
      ...editTest.ir,
      assertions: [{ ...(editTest.ir.assertions[0] as object), contains: assertionText, type: "ui", oracle: "human-approved" }],
    };
    await api(`/api/tests/${editTest.id}`, { method: "PUT", body: JSON.stringify({ ir }) });
    await api(`/api/tests/${editTest.id}/approve`, { method: "POST", body: "{}" });
    setEditTest(null);
    notify("已保存并批准");
    await refresh();
  };

  const startRecord = async () => {
    const testId = `rec-${Date.now().toString(36)}`;
    const res = await api<{ jobId: string }>("/api/record", {
      method: "POST",
      body: JSON.stringify({
        url: "http://127.0.0.1:4173/",
        testId,
        title: recordTitle || "录制用例",
      }),
    });
    setRecordJob(res.jobId);
    notify("请在弹出窗口中操作，完成后关闭窗口");
  };

  const approvedCount = tests.filter((t) => t.approvalStatus === "approved").length;

  return (
    <div className="shell">
      <header className="top">
        <div className="top-inner">
          <div className="brand">TestPilot</div>
          <nav>
            <button type="button" className={view === "home" ? "active" : ""} onClick={() => setView("home")}>
              开始
            </button>
            <button type="button" className={view === "tests" ? "active" : ""} onClick={() => setView("tests")}>
              用例
            </button>
            <button type="button" className={view === "record" ? "active" : ""} onClick={() => setView("record")}>
              录制
            </button>
            <button type="button" className={view === "history" ? "active" : ""} onClick={() => setView("history")}>
              结果
            </button>
          </nav>
        </div>
      </header>

      {demoOk === false && (
        <div className="alert-bar">
          练习应用未启动（端口 4173）。请保持 <code>pnpm dev</code> 运行，或检查终端里 demo 进程是否正常。
        </div>
      )}

      <main>
        {view === "home" && (
          <section className="hero">
            <h1>Web 测试，几步就好。</h1>
            <p>
              在练习环境里一键回归 {approvedCount} 条已批准用例。Playwright 确定性执行，正常回归不消耗 LLM。
            </p>
            <div className="cta-stack">
              <button type="button" className="btn btn-primary" disabled={loading || demoOk === false} onClick={runAll}>
                {loading ? "运行中…" : "运行全部回归"}
              </button>
            </div>
            <div className="hero-links">
              <button type="button" className="btn btn-secondary" onClick={() => setView("tests")}>
                查看用例
              </button>
              <a
                className="btn btn-secondary"
                href="http://127.0.0.1:4173/"
                target="_blank"
                rel="noreferrer"
              >
                打开练习应用
              </a>
            </div>
            {summary && summary.runCount > 0 && (
              <p className="stat">
                最近 {summary.runCount} 次运行 · 通过率 {Math.round(summary.passRate * 100)}% · 平均{" "}
                {summary.avgDurationMs} ms
                {"lastBatchDurationMs" in summary && summary.lastBatchDurationMs != null
                  ? ` · 上批回归 ${Math.round((summary as { lastBatchDurationMs: number }).lastBatchDurationMs / 1000)}s`
                  : ""}
                {"pilotBaselineMinutes" in summary && summary.pilotBaselineMinutes != null
                  ? ` · 人工基线约 ${(summary as { pilotBaselineMinutes: number }).pilotBaselineMinutes} 分钟`
                  : ""}
              </p>
            )}
          </section>
        )}

        {view === "tests" && (
          <section>
            <h2 className="section-title">用例</h2>
            <p className="section-lede">已批准用例会参与「运行全部」。草稿需编辑断言并批准。</p>
            <div className="list">
              {tests.map((t) => {
                const last = lastByTest[t.id];
                return (
                  <div className="row" key={t.id}>
                    <div>
                      <h3 className="row-title">
                        {t.title}
                        <span className={`badge ${t.approvalStatus === "draft" ? "draft" : ""}`}>
                          {t.approvalStatus === "draft" ? "草稿" : "已批准"}
                        </span>
                        {last && (
                          <span className={`status-pill ${last.status === "passed" ? "pass" : "fail"}`}>
                            {last.status === "passed" ? "通过" : "失败"}
                          </span>
                        )}
                      </h3>
                      <p>
                        {t.ir.steps?.length ?? 0} 步 · {t.ir.assertions?.length ?? 0} 断言
                      </p>
                    </div>
                    <div className="row-actions">
                      <button type="button" className="btn-small primary" disabled={loading} onClick={() => runOne(t.id)}>
                        运行
                      </button>
                      <button type="button" className="btn-small" onClick={() => openEdit(t)}>
                        断言
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {view === "record" && (
          <section>
            <h2 className="section-title">录制</h2>
            <p className="section-lede">在示例控制台里走一遍流程。关闭浏览器后自动保存为草稿。</p>
            <div className="field">
              <label>用例名称</label>
              <input
                value={recordTitle}
                onChange={(e) => setRecordTitle(e.target.value)}
                placeholder="例如：重复邮箱提示"
              />
            </div>
            <button type="button" className="btn btn-primary" disabled={!!recordJob} onClick={startRecord}>
              {recordJob ? "录制中…" : "开始录制"}
            </button>
          </section>
        )}

        {view === "history" && (
          <section>
            <h2 className="section-title">结果</h2>
            <p className="section-lede">Trace 与 network.json 每次运行都会生成（新运行的记录可下载）。</p>
            <div className="list">
              {runs.map((r) => (
                <div className="row row-history" key={r.runId}>
                  <div className="row-main">
                    <h3>{r.testTitle}</h3>
                    <p>
                      {new Date(r.completedAt).toLocaleString()} · {r.metrics?.durationMs ?? "—"} ms
                      {r.metrics?.failureKind ? ` · ${r.metrics.failureKind}` : ""}
                    </p>
                  </div>
                  <div className="row-actions row-actions-history">
                    <span className={`status-pill ${r.status === "passed" ? "pass" : "fail"}`}>
                      {r.status === "passed" ? "通过" : "失败"}
                    </span>
                    <a className="btn-small" href={`/api/runs/${r.runId}/artifacts/trace.zip`}>
                      Trace
                    </a>
                    <a className="btn-small" href={`/api/runs/${r.runId}/artifacts/network.json`}>
                      网络
                    </a>
                  </div>
                </div>
              ))}
              {runs.length === 0 && <p className="section-lede">尚无执行记录</p>}
            </div>
          </section>
        )}
      </main>

      {editTest && (
        <div className="overlay" onClick={() => setEditTest(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>断言</h2>
            <p>{editTest.title}</p>
            <div className="field">
              <label>页面应包含</label>
              <input value={assertionText} onChange={(e) => setAssertionText(e.target.value)} />
            </div>
            <div className="cta-stack">
              <button type="button" className="btn btn-primary" onClick={saveAndApprove}>
                保存并批准
              </button>
              <button type="button" className="btn-link" onClick={applySuggest}>
                智能建议
              </button>
            </div>
          </div>
        </div>
      )}

      {batchProgress && (
        <div className="overlay" aria-live="polite">
          <div className="sheet progress-sheet">
            <h2>正在回归</h2>
            <p>
              {batchProgress.completed} / {batchProgress.total}
              {batchProgress.title ? ` · ${batchProgress.title}` : ""}
            </p>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{
                  width: `${batchProgress.total ? (100 * batchProgress.completed) / batchProgress.total : 0}%`,
                }}
              />
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { api, type StoredRun, type StoredTest } from "./api";

type View = "home" | "tests" | "create" | "history";
type CreateChannel = "intent" | "prd" | "record";

export function App() {
  const [view, setView] = useState<View>("home");
  const [tests, setTests] = useState<StoredTest[]>([]);
  const [runs, setRuns] = useState<StoredRun[]>([]);
  const [lastByTest, setLastByTest] = useState<Record<string, StoredRun>>({});
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [editTest, setEditTest] = useState<StoredTest | null>(null);
  const [assertionText, setAssertionText] = useState("");
  const [assertionHelp, setAssertionHelp] = useState("");
  const [assertionSuggestions, setAssertionSuggestions] = useState<string[]>([]);
  const [reviewIntent, setReviewIntent] = useState("");
  const [createChannel, setCreateChannel] = useState<CreateChannel>("intent");
  const [createText, setCreateText] = useState("");
  const [createTitle, setCreateTitle] = useState("");
  const [createUrl, setCreateUrl] = useState("");
  const [recordJob, setRecordJob] = useState<string | null>(null);
  const [summary, setSummary] = useState<{
    passRate: number;
    avgDurationMs: number;
    runCount: number;
    lastBatchDurationMs?: number | null;
    pilotBaselineMinutes?: number | null;
  } | null>(null);
  const [demoOk, setDemoOk] = useState<boolean | null>(null);
  const [pilotOk, setPilotOk] = useState<boolean | null>(null);
  const [pilotSecrets, setPilotSecrets] = useState<boolean | null>(null);
  const [pilotUrl, setPilotUrl] = useState<string | null>(null);
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
      const env = await api<{
        demoReachable: boolean;
        demoUrl: string;
        pilotReachable?: boolean;
        pilotUrl?: string;
        pilotSecretsConfigured?: boolean;
      }>("/api/environment");
      setDemoOk(env.demoReachable);
      setPilotOk(env.pilotReachable ?? null);
      setPilotSecrets(env.pilotSecretsConfigured ?? null);
      setPilotUrl(env.pilotUrl ?? null);
      setCreateUrl((prev) => {
        if (prev) return prev;
        return env.pilotUrl ? `${env.pilotUrl.replace(/\/$/, "")}/customer` : "http://127.0.0.1:4173/";
      });
    } catch {
      setDemoOk(null);
    }
  }, []);

  useEffect(() => {
    refresh().catch((e) => notify(String(e)));
  }, [refresh]);

  const loadAssertionHints = async (t: StoredTest) => {
    const res = await api<{
      assertions: StoredTest["ir"]["assertions"];
      help?: string;
      suggestions?: string[];
    }>(`/api/tests/${t.id}/suggest-assertions`, { method: "POST", body: "{}" });
    const contains = (res.assertions[0] as { contains?: string })?.contains ?? "";
    setAssertionText(contains);
    setAssertionHelp(res.help ?? "");
    setAssertionSuggestions(res.suggestions ?? []);
  };

  const openReview = async (t: StoredTest, withHints = true) => {
    setEditTest(t);
    setReviewIntent(t.intentSummary ?? "");
    const a = t.ir.assertions?.[0] as { contains?: string } | undefined;
    const raw = a?.contains ?? "";
    setAssertionText(raw.includes("REPLACE") ? "" : raw);
    if (withHints) {
      try {
        await loadAssertionHints(t);
      } catch {
        /* ignore */
      }
    }
  };

  useEffect(() => {
    if (!recordJob) return;
    const timer = setInterval(async () => {
      const job = await api<{ status: string; error?: string; testId?: string }>(`/api/record/${recordJob}`);
      if (job.status === "running") return;
      clearInterval(timer);
      setRecordJob(null);
      if (job.status === "completed") {
        notify("录制已保存，请审阅断言");
        await refresh();
        if (job.testId) {
          const t = await api<StoredTest>(`/api/tests/${job.testId}`);
          await openReview(t);
        } else {
          setView("tests");
        }
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
    void openReview(t);
  };

  const applySuggest = async () => {
    if (!editTest) return;
    await loadAssertionHints(editTest);
    notify("已更新建议，请确认后保存");
  };

  const buildReviewIr = () => {
    if (!editTest) return null;
    return {
      ...editTest.ir,
      assertions: [
        {
          id: "review-assertion",
          type: "ui" as const,
          contains: assertionText,
          oracle: "human-approved" as const,
        },
      ],
    };
  };

  const saveDraft = async () => {
    if (!editTest) return;
    const ir = buildReviewIr();
    if (!ir || !assertionText.trim()) {
      notify("请填写断言文案");
      return;
    }
    await api(`/api/tests/${editTest.id}`, {
      method: "PUT",
      body: JSON.stringify({ ir, intentSummary: reviewIntent }),
    });
    setEditTest(null);
    notify("草稿已保存");
    await refresh();
  };

  const saveAndApprove = async () => {
    if (!editTest) return;
    const ir = buildReviewIr();
    if (!ir || !assertionText.trim()) {
      notify("请填写断言文案");
      return;
    }
    if (/附件|upload/i.test(assertionText)) {
      notify("试点约束：断言不要包含附件相关文案");
      return;
    }
    await api(`/api/tests/${editTest.id}`, {
      method: "PUT",
      body: JSON.stringify({ ir, intentSummary: reviewIntent }),
    });
    await api(`/api/tests/${editTest.id}/approve`, { method: "POST", body: "{}" });
    setEditTest(null);
    notify("已保存并批准");
    await refresh();
  };

  const submitIntake = async () => {
    const title = createTitle.trim() || "未命名用例";
    const url = createUrl.trim();
    const text =
      createText.trim() ||
      "登录后提交工单，只填必填项，不要上传附件（附件功能暂不测试）。";
    try {
      const res = await api<{ test: StoredTest }>("/api/intake", {
        method: "POST",
        body: JSON.stringify({
          title,
          url,
          channel: createChannel === "prd" ? "prd" : "intent",
          text,
        }),
      });
      notify("已生成草稿，请审阅步骤与断言");
      await openReview(res.test);
      await refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  const startRecord = async () => {
    const testId = `rec-${Date.now().toString(36)}`;
    const url =
      createUrl.trim() ||
      (pilotUrl ? `${pilotUrl.replace(/\/$/, "")}/admin/login` : "http://127.0.0.1:4173/");
    const intentSummary =
      createText.trim() ||
      (createTitle.includes("工单") ? "提交工单；不要上传附件，附件功能暂不测试。" : undefined);
    try {
      const res = await api<{ jobId: string }>("/api/record", {
        method: "POST",
        body: JSON.stringify({
          url,
          testId,
          title: createTitle.trim() || "录制用例",
          intentSummary,
        }),
      });
      setRecordJob(res.jobId);
      notify("录制窗口即将打开，操作完成后请关闭该窗口");
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
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
            <button type="button" className={view === "create" ? "active" : ""} onClick={() => setView("create")}>
              创建
            </button>
            <button type="button" className={view === "history" ? "active" : ""} onClick={() => setView("history")}>
              结果
            </button>
          </nav>
        </div>
      </header>

      {demoOk === false && (
        <div className="alert-bar">
          练习应用未启动（端口 4173）。Demo 用例需 <code>pnpm dev</code>；试点用例不受影响。
        </div>
      )}
      {pilotOk === false && (
        <div className="alert-bar">
          试点环境不可达{pilotUrl ? `（${pilotUrl}）` : ""}。请检查网络或 TESTPILOT_PILOT_BASE_URL。
        </div>
      )}
      {pilotSecrets === false && (
        <div className="alert-bar">
          试点登录凭据未配置：复制 <code>.env.example</code> 为 <code>.env</code> 并填写管理员手机号与密码，然后重启 API。
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
              <button
                type="button"
                className="btn btn-primary"
                disabled={loading || (demoOk === false && pilotOk === false)}
                onClick={runAll}
              >
                {loading ? "运行中…" : "运行全部回归"}
              </button>
            </div>
            <div className="hero-links">
              <button type="button" className="btn btn-secondary" onClick={() => setView("tests")}>
                查看用例
              </button>
              <a className="btn btn-secondary" href="http://127.0.0.1:4173/" target="_blank" rel="noreferrer">
                打开练习应用
              </a>
              <a
                className="btn btn-secondary"
                href={pilotUrl ? `${pilotUrl}/admin/login` : "#"}
                onClick={(e) => {
                  if (!pilotUrl) {
                    e.preventDefault();
                    notify("请在本机 .env 配置 TESTPILOT_PILOT_BASE_URL");
                  }
                }}
                target="_blank"
                rel="noreferrer"
              >
                打开试点登录
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
                        审阅
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {view === "create" && (
          <section>
            <h2 className="section-title">创建用例</h2>
            <p className="section-lede">
              用一句话、PRD 片段或录制表达测试意图；系统生成可执行草案，你再审阅断言即可。
            </p>
            <div className="tabs">
              {(
                [
                  ["intent", "一句话"],
                  ["prd", "PRD / 文档"],
                  ["record", "录制"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`tab ${createChannel === id ? "active" : ""}`}
                  onClick={() => setCreateChannel(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="field">
              <label>用例名称</label>
              <input
                value={createTitle}
                onChange={(e) => setCreateTitle(e.target.value)}
                placeholder="例如：用例1 — 提交工单（无附件）"
              />
            </div>
            <div className="field">
              <label>起始 URL</label>
              <input
                value={createUrl}
                onChange={(e) => setCreateUrl(e.target.value)}
                placeholder="登录后页面或 /admin/login"
              />
            </div>
            {createChannel !== "record" && (
              <div className="field">
                <label>{createChannel === "prd" ? "粘贴 PRD / 需求片段" : "你想测什么？"}</label>
                <textarea
                  className="textarea"
                  rows={5}
                  value={createText}
                  onChange={(e) => setCreateText(e.target.value)}
                  placeholder="例如：登录后提交一条工单，只填必填项，不要上传附件。"
                />
              </div>
            )}
            {createChannel === "record" && (
              <div className="field">
                <label>补充说明（可选）</label>
                <textarea
                  className="textarea"
                  rows={3}
                  value={createText}
                  onChange={(e) => setCreateText(e.target.value)}
                  placeholder="例如：提交工单时不要带附件"
                />
              </div>
            )}
            <p className="hint-inline">试点约束：提交工单流程不要测附件上传。</p>
            {createChannel === "record" ? (
              <button type="button" className="btn btn-primary" disabled={!!recordJob} onClick={startRecord}>
                {recordJob ? "录制中…" : "开始录制"}
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={submitIntake}>
                生成草稿
              </button>
            )}
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
          <div className="sheet sheet-wide" onClick={(e) => e.stopPropagation()}>
            <h2>审阅用例</h2>
            <p>{editTest.title}</p>
            <p className="hint-inline">{editTest.ir.steps?.length ?? 0} 个步骤 · 来源 {editTest.sourceChannel ?? "未知"}</p>
            <div className="field">
              <label>测试意图（可编辑，供建议引擎参考）</label>
              <textarea
                className="textarea"
                rows={2}
                value={reviewIntent}
                onChange={(e) => setReviewIntent(e.target.value)}
              />
            </div>
            <div className="field">
              <label>页面应包含</label>
              <p className="hint-inline">{assertionHelp || "填写操作成功后页面上可见的稳定文案。"}</p>
              <input value={assertionText} onChange={(e) => setAssertionText(e.target.value)} />
              {assertionSuggestions.length > 0 && (
                <div className="chips">
                  {assertionSuggestions.map((s) => (
                    <button key={s} type="button" className="chip" onClick={() => setAssertionText(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="cta-stack">
              <button type="button" className="btn btn-primary" onClick={saveAndApprove}>
                保存并批准
              </button>
              <button type="button" className="btn btn-secondary" onClick={saveDraft}>
                仅保存草稿
              </button>
              <button type="button" className="btn-link" onClick={applySuggest}>
                刷新建议
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

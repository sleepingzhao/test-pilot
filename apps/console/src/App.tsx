import { useCallback, useEffect, useState } from "react";
import { api, type StoredRun, type StoredTest } from "./api";
import { describeStep, failureKindLabel, failureScreenshotPath, summarizeAssertion } from "./stepSummary";

type IrAssertion = {
  id?: string;
  type?: string;
  contains?: string;
  requestRef?: string;
  expect?: Record<string, unknown>;
  target?: unknown;
  oracle?: string;
};

type View = "home" | "tests" | "create" | "history";
type CreateChannel = "intent" | "prd" | "record";
type TestFilter = "all" | "draft" | "weak" | "pilot" | "demo";

function isPilotTest(t: StoredTest): boolean {
  if (t.title.includes("【试点】")) return true;
  if (t.id.startsWith("pilot-auto-") || t.id.startsWith("pilot-admin-")) return true;
  if (t.ir?.baseUrlRef === "pilot-admin") return true;
  return false;
}

export function App() {
  const [view, setView] = useState<View>("home");
  const [testFilter, setTestFilter] = useState<TestFilter>("all");
  const [tests, setTests] = useState<StoredTest[]>([]);
  const [runs, setRuns] = useState<StoredRun[]>([]);
  const [lastByTest, setLastByTest] = useState<Record<string, StoredRun>>({});
  const [bootstrapped, setBootstrapped] = useState(false);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [editTest, setEditTest] = useState<StoredTest | null>(null);
  const [assertionText, setAssertionText] = useState("");
  const [apiExpectJson, setApiExpectJson] = useState("");
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
    minutesSavedVsBaseline?: number | null;
    lastBatchMinutes?: number | null;
    approvedTestCount?: number;
    approvedPilotCount?: number;
    approvedDemoCount?: number;
    weakApprovedCount?: number;
    weakApprovedTests?: Array<{ id: string; title: string; count: number }>;
    recentBatches?: Array<{ startedAt: string; total: number; passed: number; durationMs: number }>;
  } | null>(null);
  const [demoOk, setDemoOk] = useState<boolean | null>(null);
  const [pilotOk, setPilotOk] = useState<boolean | null>(null);
  const [pilotSecrets, setPilotSecrets] = useState<boolean | null>(null);
  const [pilotUrl, setPilotUrl] = useState<string | null>(null);
  const [pilotIntakeUrl, setPilotIntakeUrl] = useState<string | null>(null);
  const [pilotScopeNote, setPilotScopeNote] = useState<string | null>(null);
  const [llmInfo, setLlmInfo] = useState<{
    enabled: boolean;
    provider?: string;
    model?: string;
    error?: string;
    lastError?: string | null;
  } | null>(null);
  const [diagnoseRun, setDiagnoseRun] = useState<StoredRun | null>(null);
  const [diagnoseDetail, setDiagnoseDetail] = useState<{
    failureKind: string | null;
    stepError?: string;
    assertionMessage?: string;
    suggestions: string[];
    llmUsed?: boolean;
  } | null>(null);
  const [diagnoseLoading, setDiagnoseLoading] = useState(false);
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
        minutesSavedVsBaseline?: number | null;
        lastBatchMinutes?: number | null;
        approvedPilotCount?: number;
        approvedDemoCount?: number;
        approvedTestCount?: number;
        weakApprovedCount?: number;
        weakApprovedTests?: Array<{ id: string; title: string; count: number }>;
        recentBatches?: Array<{ startedAt: string; total: number; passed: number; durationMs: number }>;
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
        pilotIntakeUrl?: string | null;
        pilotSecretsConfigured?: boolean;
        llm?: { enabled: boolean; provider?: string; model?: string; error?: string };
        llmUsage?: { lastError?: string | null };
      }>("/api/environment");
      setDemoOk(env.demoReachable);
      setPilotOk(env.pilotReachable ?? null);
      setPilotSecrets(env.pilotSecretsConfigured ?? null);
      setPilotUrl(env.pilotUrl ?? null);
      setLlmInfo(env.llm ? { ...env.llm, lastError: env.llmUsage?.lastError ?? null } : null);
      setPilotIntakeUrl(env.pilotIntakeUrl ?? null);
      setCreateUrl((prev) => {
        if (prev) return prev;
        if (env.pilotIntakeUrl) return env.pilotIntakeUrl;
        return env.pilotUrl ? `${env.pilotUrl.replace(/\/$/, "")}/customer` : "http://127.0.0.1:4173/";
      });
    } catch {
      setDemoOk(null);
    }
    try {
      const c = await api<{ scopeNotes?: string[] }>("/api/pilot-constraints");
      setPilotScopeNote(c.scopeNotes?.[0] ?? null);
    } catch {
      setPilotScopeNote(null);
    } finally {
      setBootstrapped(true);
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
    const a = t.ir.assertions?.find((x) => (x as IrAssertion).type === "ui") as { contains?: string } | undefined;
    const raw = a?.contains ?? "";
    setAssertionText(raw.includes("REPLACE") ? "" : raw);
    const apiA = t.ir.assertions?.find((x) => (x as IrAssertion).type === "api") as IrAssertion | undefined;
    setApiExpectJson(apiA?.expect ? JSON.stringify(apiA.expect, null, 2) : "");
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

  const summarizeRuns = (runs: StoredRun[]) => {
    const passed = runs.filter((r) => r.status === "passed").length;
    const failed = runs.filter((r) => r.status !== "passed");
    if (failed.length === 0) {
      return `回归完成：${passed}/${runs.length} 通过`;
    }
    const names = failed.slice(0, 3).map((r) => r.testTitle);
    const more = failed.length > 3 ? ` 等 ${failed.length} 条` : "";
    return `回归 ${passed}/${runs.length} 通过；失败：${names.join("、")}${more}`;
  };

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
      notify(summarizeRuns(job.runs));
      await refresh();
      if (passed < job.runs.length) setView("history");
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
        notify(summarizeRuns(rs));
        if (rs.some((r) => r.status !== "passed")) setView("history");
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
      const res = await api<{ runs: StoredRun[] }>("/api/projects/default/runs", {
        method: "POST",
        body: JSON.stringify({ testId: id }),
      });
      const run = res.runs?.[0];
      await refresh();
      if (run?.status === "passed") {
        notify("通过");
        return;
      }
      if (run) {
        notify("未通过，打开诊断");
        void openDiagnose(run);
      } else {
        notify("执行完成");
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const openDiagnose = async (run: StoredRun) => {
    setDiagnoseRun(run);
    setDiagnoseDetail(null);
    setDiagnoseLoading(true);
    try {
      const d = await api<{
        failureKind: string | null;
        stepError?: string;
        assertionMessage?: string;
        suggestions: string[];
        llmUsed?: boolean;
      }>(`/api/runs/${run.runId}/diagnose`);
      setDiagnoseDetail(d);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
      setDiagnoseRun(null);
    } finally {
      setDiagnoseLoading(false);
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
    const base = [...((editTest.ir.assertions ?? []) as IrAssertion[])];
    let uiIdx = base.findIndex((a) => a.type === "ui");
    const uiPatch: IrAssertion = {
      ...(uiIdx >= 0 ? base[uiIdx]! : { id: "review-assertion", type: "ui", oracle: "human-approved" }),
      type: "ui",
      contains: assertionText,
      oracle: "human-approved",
    };
    if (uiIdx >= 0) base[uiIdx] = uiPatch;
    else base.unshift(uiPatch);

    if (apiExpectJson.trim()) {
      try {
        const expect = JSON.parse(apiExpectJson) as Record<string, unknown>;
        let apiIdx = base.findIndex((a) => a.type === "api");
        if (apiIdx < 0) {
          base.push({
            id: "api-contract",
            type: "api",
            requestRef: "users-create-attempt",
            expect,
            oracle: "api-contract",
          });
        } else {
          base[apiIdx] = { ...base[apiIdx]!, expect: { ...(base[apiIdx]!.expect ?? {}), ...expect } };
        }
      } catch {
        return null;
      }
    }
    return { ...editTest.ir, assertions: base };
  };

  const reviewIrValid = () => {
    if (!assertionText.trim() && !apiExpectJson.trim()) return false;
    if (apiExpectJson.trim()) {
      try {
        JSON.parse(apiExpectJson);
      } catch {
        return false;
      }
    }
    return Boolean(buildReviewIr());
  };

  const saveDraft = async () => {
    if (!editTest) return;
    const ir = buildReviewIr();
    if (!ir || !reviewIrValid()) {
      notify("请填写 UI 断言文案，或填写合法的 API expect JSON");
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
    if (!ir || !reviewIrValid()) {
      notify("请填写 UI 断言文案，或填写合法的 API expect JSON");
      return;
    }
    if (/附件|upload/i.test(assertionText)) {
      notify("试点约束：断言不要包含附件相关文案");
      return;
    }
    try {
      const saved = await api<StoredTest>(`/api/tests/${editTest.id}`, {
        method: "PUT",
        body: JSON.stringify({ ir, intentSummary: reviewIntent }),
      });
      await api(`/api/tests/${editTest.id}/approve`, {
        method: "POST",
        body: JSON.stringify({ irHash: saved.irHash }),
      });
      setEditTest(null);
      notify("已保存并批准");
      await refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
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
      pilotIntakeUrl ||
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

  const approvedCount = bootstrapped
    ? tests.filter((t) => t.approvalStatus === "approved").length
    : (summary?.approvedTestCount ?? null);
  const draftCount = tests.filter((t) => t.approvalStatus === "draft").length;
  const approvedPilot =
    summary?.approvedPilotCount ??
    tests.filter((t) => t.approvalStatus === "approved" && isPilotTest(t)).length;
  const approvedDemo =
    summary?.approvedDemoCount ??
    (typeof approvedCount === "number" ? approvedCount - approvedPilot : 0);
  const sortedTests = [...tests].sort((a, b) => {
    if (a.approvalStatus === "draft" && b.approvalStatus !== "draft") return -1;
    if (a.approvalStatus !== "draft" && b.approvalStatus === "draft") return 1;
    const aWeak = a.approvalStatus === "approved" && (a.weakAssertions?.length ?? 0) > 0;
    const bWeak = b.approvalStatus === "approved" && (b.weakAssertions?.length ?? 0) > 0;
    if (aWeak && !bWeak) return -1;
    if (!aWeak && bWeak) return 1;
    return a.title.localeCompare(b.title, "zh-CN");
  });
  const filteredTests = sortedTests.filter((t) => {
    if (testFilter === "draft") return t.approvalStatus === "draft";
    if (testFilter === "weak") return (t.weakAssertions?.length ?? 0) > 0;
    if (testFilter === "pilot") return isPilotTest(t);
    if (testFilter === "demo") return !isPilotTest(t);
    return true;
  });

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand">TestPilot</div>
        <nav className="side-nav">
          <button type="button" className={view === "home" ? "active" : ""} onClick={() => setView("home")}>
            开始
          </button>
          <button type="button" className={view === "tests" ? "active" : ""} onClick={() => setView("tests")}>
            用例
            {draftCount > 0 ? <span className="nav-badge">{draftCount}</span> : null}
          </button>
          <button type="button" className={view === "create" ? "active" : ""} onClick={() => setView("create")}>
            创建
          </button>
          <button type="button" className={view === "history" ? "active" : ""} onClick={() => setView("history")}>
            结果
          </button>
        </nav>
      </aside>

      <div className="content-column">
      {draftCount > 0 && (
        <div className="alert-bar alert-bar-draft">
          有 <strong>{draftCount}</strong> 条用例待审阅（含试点 auto-intake）。请打开「用例 → 草稿」，核对 UI / API 断言后点「保存并批准」；未批准不会进入「运行全部」。
        </div>
      )}
      {summary && (summary.weakApprovedCount ?? 0) > 0 && (
        <div className="alert-bar">
          有 <strong>{summary.weakApprovedCount}</strong> 条已批准用例使用弱断言，可能产生假阳性。请打开「用例 → 弱断言」审阅并强化。
        </div>
      )}
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
      {llmInfo && !llmInfo.enabled && pilotOk !== false && (
        <div className="alert-bar" style={{ background: "#f5f5f7", color: "#6e6e73", borderColor: "#d2d2d7" }}>
          {llmInfo.error
            ? `LLM 配置无效：${llmInfo.error}`
            : "LLM 未启用：在 .env 中设置 TESTPILOT_LLM_API_KEY（见 .env.example / docs/llm.md）。"}
        </div>
      )}
      {llmInfo?.enabled && llmInfo.lastError && (
        <div className="alert-bar">最近一次 LLM 调用失败：{llmInfo.lastError}</div>
      )}

      <main>
        {view === "home" && (
          <section className="hero">
            <h1>Web 测试，几步就好。</h1>
            <p>
              在练习环境里一键回归 {approvedCount ?? "…"} 条已批准用例
              {approvedPilot > 0 ? `（试点 ${approvedPilot} · 练习 ${approvedDemo}）` : ""}
              。试点草稿由 API 自动生成，新用例审阅批准一次即可。
              {llmInfo?.enabled ? (
                <>
                  {" "}
                  LLM 已启用（{llmInfo.provider}/{llmInfo.model}），仅用于草稿与诊断。
                </>
              ) : null}
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
              {draftCount > 0 && (
                <button type="button" className="btn btn-primary" onClick={() => setView("tests")}>
                  审阅 {draftCount} 条草稿
                </button>
              )}
              <button type="button" className="btn btn-secondary" onClick={() => setView("tests")}>
                查看用例
              </button>
              <a className="btn btn-secondary" href="http://127.0.0.1:4173/" target="_blank" rel="noreferrer">
                打开练习应用
              </a>
              <a
                className="btn btn-secondary"
                href={pilotIntakeUrl ?? pilotUrl ?? "#"}
                onClick={(e) => {
                  if (!pilotIntakeUrl && !pilotUrl) {
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
                {summary.lastBatchDurationMs != null
                  ? ` · 上批回归 ${Math.round(summary.lastBatchDurationMs / 1000)}s`
                  : ""}
                {summary.pilotBaselineMinutes != null
                  ? ` · 人工基线约 ${summary.pilotBaselineMinutes} 分钟`
                  : ""}
                {summary.minutesSavedVsBaseline != null && summary.minutesSavedVsBaseline > 0
                  ? ` · 较基线节省约 ${summary.minutesSavedVsBaseline} 分钟`
                  : ""}
              </p>
            )}
            {summary && summary.recentBatches?.length ? (
              <div className="batch-trend">
                <h3 className="batch-trend-title">最近回归批次</h3>
                <ul className="batch-trend-list">
                  {summary.recentBatches.map(
                    (b) => (
                      <li key={b.startedAt}>
                        <span>{new Date(b.startedAt).toLocaleString()}</span>
                        <span className={b.passed === b.total ? "batch-ok" : "batch-warn"}>
                          {b.passed}/{b.total} 通过
                        </span>
                        <span className="batch-dur">{Math.round(b.durationMs / 1000)}s</span>
                      </li>
                    ),
                  )}
                </ul>
              </div>
            ) : null}
          </section>
        )}

        {view === "tests" && (
          <section>
            <h2 className="section-title">用例</h2>
            <p className="section-lede">已批准用例会参与「运行全部」。草稿需编辑断言并批准。</p>
            <div className="test-filters">
              {(
                [
                  ["all", "全部"],
                  ["draft", "草稿"],
                  ["weak", "弱断言"],
                  ["pilot", "试点"],
                  ["demo", "练习"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={testFilter === id ? "active" : ""}
                  onClick={() => setTestFilter(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="list">
              {filteredTests.map((t) => {
                const last = lastByTest[t.id];
                return (
                  <div className="row" key={t.id}>
                    <div>
                      <h3 className="row-title">
                        {t.title}
                        <span className={`badge ${t.approvalStatus === "draft" ? "draft" : ""}`}>
                          {t.approvalStatus === "draft" ? "草稿" : "已批准"}
                        </span>
                        {(t.weakAssertions?.length ?? 0) > 0 && (
                          <span
                            className="badge weak"
                            title={t.weakAssertions!.map((item) => item.message).join("\n")}
                          >
                            弱断言 {t.weakAssertions!.length}
                          </span>
                        )}
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
                      {last && last.status !== "passed" && (
                        <button type="button" className="btn-small" onClick={() => void openDiagnose(last)}>
                          诊断
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {filteredTests.length === 0 && <p className="section-lede">没有匹配的用例</p>}
            </div>
          </section>
        )}

        {view === "create" && (
          <section>
            <h2 className="section-title">创建用例</h2>
            <p className="section-lede">
              用一句话、PRD 片段或录制表达测试意图；系统生成可执行草案，你再审阅断言即可。
            </p>
            <div className="create-layout">
              <nav className="create-nav" aria-label="创建方式">
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
                    className={createChannel === id ? "active" : ""}
                    onClick={() => setCreateChannel(id)}
                  >
                    {label}
                  </button>
                ))}
              </nav>
              <div className="create-panel">
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
                <div className="chips">
                  <button
                    type="button"
                    className="chip"
                    onClick={() => {
                      setCreateTitle("用例1 — 提交工单（无附件）");
                      setCreateText(
                        "登录后进入工单页，点击提交工单，只填写必填项并提交，不要上传附件，附件功能暂不测试。",
                      );
                    }}
                  >
                    用例1：提交工单
                  </button>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => {
                      setCreateTitle("试点 — 密码登录");
                      setCreateText("使用管理员手机号和密码登录，进入首页。");
                    }}
                  >
                    密码登录
                  </button>
                </div>
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
              </div>
            </div>
          </section>
        )}

        {view === "history" && (
          <section>
            <h2 className="section-title">结果</h2>
            <p className="section-lede">Trace 与 network.json 每次运行都会生成（新运行的记录可下载）。</p>
            <div className="list">
              {runs.map((r) => {
                const shotHref = failureScreenshotPath(r);
                return (
                <div className="row row-history" key={r.runId}>
                  <div className="row-main">
                    <h3>{r.testTitle}</h3>
                    <p>
                      {new Date(r.completedAt).toLocaleString()} · {r.metrics?.durationMs ?? "—"} ms
                      {failureKindLabel(r.metrics?.failureKind)
                        ? ` · ${failureKindLabel(r.metrics?.failureKind)}`
                        : ""}
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
                    {shotHref && (
                      <a className="btn-small" href={shotHref} target="_blank" rel="noreferrer">
                        截图
                      </a>
                    )}
                    {r.status !== "passed" && (
                      <button type="button" className="btn-small primary" onClick={() => void openDiagnose(r)}>
                        诊断
                      </button>
                    )}
                  </div>
                </div>
              );
              })}
              {runs.length === 0 && <p className="section-lede">尚无执行记录</p>}
            </div>
          </section>
        )}
      </main>
      </div>

      {editTest && (
        <div className="overlay" onClick={() => setEditTest(null)}>
          <div className="sheet sheet-wide sheet-review" onClick={(e) => e.stopPropagation()} role="dialog" aria-labelledby="review-title">
            <header className="sheet-review-header">
              <div className="sheet-review-header-row">
                <h2 id="review-title">审阅用例</h2>
                <button type="button" className="sheet-close" aria-label="关闭" onClick={() => setEditTest(null)}>
                  ×
                </button>
              </div>
              <p className="sheet-review-subtitle">{editTest.title}</p>
              <p className="hint-inline sheet-review-meta">
                {editTest.ir.steps?.length ?? 0} 个步骤 · 来源 {editTest.sourceChannel ?? "未知"}
              </p>
            </header>
            <div className="sheet-review-body">
              {pilotScopeNote && <p className="hint-inline">试点：{pilotScopeNote}</p>}
              {editTest.plannerNotes && editTest.plannerNotes.length > 0 && (
                <ul className="diagnose-list planner-notes">
                  {editTest.plannerNotes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              {(editTest.ir.steps?.length ?? 0) > 0 && (
                <>
                  <p className="hint-inline">步骤预览</p>
                  <ul className="step-list">
                    {(editTest.ir.steps as Parameters<typeof describeStep>[0][]).map((step, i) => (
                      <li key={(step as { id?: string }).id ?? i}>{describeStep(step, i)}</li>
                    ))}
                  </ul>
                </>
              )}
              {(editTest.ir.assertions?.length ?? 0) > 0 && (
                <>
                  <p className="hint-inline">当前断言（保存时会更新 UI 文案与 API expect，不会删掉 API 断言）</p>
                  <ul className="step-list assertion-list">
                    {(editTest.ir.assertions as IrAssertion[]).map((a, i) => (
                      <li key={a.id ?? i}>{summarizeAssertion(a, i)}</li>
                    ))}
                  </ul>
                </>
              )}
              {editTest.weakAssertions && editTest.weakAssertions.length > 0 && (
                <div className="weak-assertion-box">
                  <p className="hint-inline">弱断言警告（批准前需改强）</p>
                  <ul className="diagnose-list">
                    {editTest.weakAssertions.map((item) => (
                      <li key={item.path}>{item.message}</li>
                    ))}
                  </ul>
                </div>
              )}
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
                <label>页面应包含（UI 断言）</label>
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
              <div className="field field-last">
                <label>API expect（JSON，可选）</label>
                <p className="hint-inline">
                  支持 <code>statusCode</code>、<code>jsonBody</code>（请求体字段）、<code>requestBodyContains</code>（子串）。例：{" "}
                  {`{"statusCode":409,"jsonBody":{"error":"duplicate"}}`}
                </p>
                <textarea
                  className="textarea"
                  rows={4}
                  value={apiExpectJson}
                  onChange={(e) => setApiExpectJson(e.target.value)}
                  placeholder='{"statusCode": 201, "requestBodyContains": "@example.com"}'
                />
              </div>
            </div>
            <footer className="sheet-review-footer">
              <div className="sheet-actions">
                <button type="button" className="btn btn-primary" onClick={saveAndApprove}>
                  保存并批准
                </button>
                <button type="button" className="btn btn-secondary" onClick={saveDraft}>
                  仅保存草稿
                </button>
                <button type="button" className="btn btn-tertiary sheet-action-span" onClick={applySuggest}>
                  刷新建议
                </button>
              </div>
            </footer>
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

      {diagnoseRun && (
        <div className="overlay" onClick={() => setDiagnoseRun(null)}>
          <div className="sheet sheet-wide diagnose-sheet" onClick={(e) => e.stopPropagation()}>
            <h2>失败诊断</h2>
            <p>{diagnoseRun.testTitle}</p>
            {diagnoseLoading && <p className="hint-inline">分析中…</p>}
            {diagnoseDetail && (
              <>
                {diagnoseDetail.failureKind && (
                  <p className="diagnose-kind">
                    分型：<strong>{failureKindLabel(diagnoseDetail.failureKind) ?? diagnoseDetail.failureKind}</strong>
                  </p>
                )}
                {diagnoseDetail.stepError && (
                  <p className="diagnose-msg">步骤：{diagnoseDetail.stepError}</p>
                )}
                {diagnoseDetail.assertionMessage && (
                  <p className="diagnose-msg">断言：{diagnoseDetail.assertionMessage}</p>
                )}
                <ul className="diagnose-list">
                  {diagnoseDetail.suggestions.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
                <p className="hint-inline">
                  {diagnoseDetail.llmUsed
                    ? "已合并 LLM 建议（仅诊断，回归仍不调用 LLM）。"
                    : "回归执行不调用 LLM；在 .env 配置 TESTPILOT_LLM_API_KEY 见 docs/llm.md。"}
                </p>
              </>
            )}
            <button type="button" className="btn btn-secondary" onClick={() => setDiagnoseRun(null)}>
              关闭
            </button>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

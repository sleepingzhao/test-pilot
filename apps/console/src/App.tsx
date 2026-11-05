import { useCallback, useEffect, useRef, useState } from "react";
import { api, type StoredRun, type StoredTest } from "./api";
import {
  AssertionProviderPanel,
  buildProviderAssertion,
  type AssertionCatalog,
  type ProviderDraft,
  type ProviderFeedback,
} from "./AssertionProviderPanel";
import type { TestStep } from "@testpilot/test-ir/step-edit";
import { StepEditorPanel } from "./StepEditorPanel";
import { failureKindLabel, failureScreenshotPath, summarizeAssertion } from "./stepSummary";

type IrAssertion = {
  id?: string;
  type?: string;
  contains?: string;
  requestRef?: string;
  expect?: Record<string, unknown>;
  target?: unknown;
  provider?: string;
  configRef?: string;
  oracle?: string;
};

type View = "home" | "tests" | "create" | "history" | "audit";
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
  const [toast, setToast] = useState<{ message: string; kind: "info" | "success" | "error" } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reviewToken = useRef(0);
  const [editTest, setEditTest] = useState<StoredTest | null>(null);
  const [assertionText, setAssertionText] = useState("");
  const [apiExpectJson, setApiExpectJson] = useState("");
  const [assertionHelp, setAssertionHelp] = useState("");
  const [assertionSuggestions, setAssertionSuggestions] = useState<string[]>([]);
  const [reviewIntent, setReviewIntent] = useState("");
  const [reviewSteps, setReviewSteps] = useState<TestStep[]>([]);
  const [reviewDirty, setReviewDirty] = useState(false);
  const [trialRunning, setTrialRunning] = useState(false);
  const [trialResult, setTrialResult] = useState<StoredRun | null>(null);
  const [assertionCatalog, setAssertionCatalog] = useState<AssertionCatalog | null>(null);
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>({
    enabled: false,
    type: "db",
    configRef: "pilot-db",
    expectJson: '{\n  "queryRef": "order-by-run-id",\n  "rowCount": 1\n}',
    id: "db-business",
    traceRef: "demo-run",
  });
  const [providerFeedback, setProviderFeedback] = useState<ProviderFeedback>({});
  const [providerBusy, setProviderBusy] = useState(false);
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
    flakeRecoveryCount?: number;
    flakeRecoveryRate?: number;
    multiAttemptRuns?: number;
  } | null>(null);
  const [demoOk, setDemoOk] = useState<boolean | null>(null);
  const [demoUrl, setDemoUrl] = useState("http://127.0.0.1:4173/");
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
  const [approvalInfo, setApprovalInfo] = useState<{
    approvalTokenRequired: boolean;
    approvalActors: string[] | null;
  } | null>(null);
  const [approvalActor, setApprovalActor] = useState(() => {
    try {
      return localStorage.getItem("testpilot-approval-actor") ?? "";
    } catch {
      return "";
    }
  });
  const [approvalTokenInput, setApprovalTokenInput] = useState(() => {
    try {
      return localStorage.getItem("testpilot-approval-token") ?? "";
    } catch {
      return "";
    }
  });
  const [auditEntries, setAuditEntries] = useState<
    Array<{ at: string; testId: string; title: string; actor: string; irHash: string }>
  >([]);

  const persistApprovalActor = (value: string) => {
    setApprovalActor(value);
    try {
      const trimmed = value.trim();
      if (trimmed) localStorage.setItem("testpilot-approval-actor", trimmed);
      else localStorage.removeItem("testpilot-approval-actor");
    } catch {
      /* ignore */
    }
  };

  const persistApprovalToken = (value: string) => {
    setApprovalTokenInput(value);
    try {
      const trimmed = value.trim();
      if (trimmed) localStorage.setItem("testpilot-approval-token", trimmed);
      else localStorage.removeItem("testpilot-approval-token");
    } catch {
      /* ignore */
    }
  };

  const notify = (message: string, kind: "info" | "success" | "error" = "info") => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, kind });
    toastTimer.current = setTimeout(() => setToast(null), 4500);
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
        flakeRecoveryCount?: number;
        flakeRecoveryRate?: number;
        multiAttemptRuns?: number;
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
        approval?: { approvalTokenRequired: boolean; approvalActors: string[] | null };
      }>("/api/environment");
      setApprovalInfo(env.approval ?? null);
      setDemoOk(env.demoReachable);
      if (env.demoUrl) setDemoUrl(env.demoUrl);
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
      const audit = await api<{
        entries: Array<{ at: string; testId: string; title: string; actor: string; irHash: string }>;
      }>("/api/audit?limit=12");
      setAuditEntries(audit.entries);
    } catch {
      setAuditEntries([]);
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

  const loadAssertionCatalog = async () => {
    const [providersRes, configRes] = await Promise.all([
      api<{ providers: AssertionCatalog["providers"] }>("/api/assertions/providers"),
      api<{ dbs: AssertionCatalog["dbs"]; agents: AssertionCatalog["agents"] }>(
        "/api/assertions/config-catalog",
      ),
    ]);
    setAssertionCatalog({
      providers: providersRes.providers,
      dbs: configRes.dbs,
      agents: configRes.agents,
    });
  };

  const loadAssertionHints = async (t: StoredTest, token?: number) => {
    const res = await api<{
      assertions: StoredTest["ir"]["assertions"];
      help?: string;
      suggestions?: string[];
    }>(`/api/tests/${t.id}/suggest-assertions`, { method: "POST", body: "{}" });
    if (token !== undefined && token !== reviewToken.current) return;
    const contains = (res.assertions[0] as { contains?: string })?.contains ?? "";
    // Suggestions must never overwrite a reviewed assertion; only fill an empty field.
    setAssertionText((prev) => (prev.trim() ? prev : contains));
    setAssertionHelp(res.help ?? "");
    setAssertionSuggestions(res.suggestions ?? []);
  };

  const openReview = async (t: StoredTest, withHints = true) => {
    const requestToken = ++reviewToken.current;
    setEditTest(t);
    setReviewSteps([...(t.ir.steps ?? [])] as TestStep[]);
    setReviewDirty(false);
    setTrialResult(null);
    setReviewIntent(t.intentSummary ?? "");
    setProviderFeedback({});
    const a = t.ir.assertions?.find((x) => (x as IrAssertion).type === "ui") as { contains?: string } | undefined;
    const raw = a?.contains ?? "";
    setAssertionText(raw.includes("REPLACE") ? "" : raw);
    const apiA = t.ir.assertions?.find((x) => (x as IrAssertion).type === "api") as IrAssertion | undefined;
    setApiExpectJson(apiA?.expect ? JSON.stringify(apiA.expect, null, 2) : "");
    const dbA = t.ir.assertions?.find((x) => (x as IrAssertion).type === "db") as IrAssertion | undefined;
    const agentA = t.ir.assertions?.find((x) => (x as IrAssertion).type === "agent") as IrAssertion | undefined;
    const ext = dbA ?? agentA;
    if (ext && (ext.type === "db" || ext.type === "agent")) {
      setProviderDraft({
        enabled: true,
        type: ext.type,
        configRef: ext.configRef ?? (ext.type === "db" ? "pilot-db" : "agent-observability"),
        expectJson: JSON.stringify(ext.expect ?? {}, null, 2),
        id: ext.id ?? (ext.type === "db" ? "db-business" : "agent-tools"),
        traceRef: String((ext.expect as { traceRef?: string })?.traceRef ?? "demo-run"),
      });
    } else {
      setProviderDraft({
        enabled: false,
        type: "db",
        configRef: "pilot-db",
        expectJson: '{\n  "queryRef": "order-by-run-id",\n  "rowCount": 1\n}',
        id: "db-business",
        traceRef: "demo-run",
      });
    }
    try {
      await loadAssertionCatalog();
    } catch {
      /* catalog optional for basic review */
    }
    if (withHints) {
      try {
        await loadAssertionHints(t, requestToken);
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

  const closeReview = () => {
    if (reviewDirty && !window.confirm("有未保存的步骤或断言修改，确定关闭？")) return;
    setEditTest(null);
    setTrialResult(null);
    setReviewDirty(false);
  };

  useEffect(() => {
    if (!editTest) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeReview();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const markReviewDirty = () => {
    setReviewDirty(true);
    setTrialResult(null);
  };

  const updateReviewSteps = (next: TestStep[]) => {
    setReviewSteps(next);
    markReviewDirty();
  };

  const buildReviewIr = () => {
    if (!editTest) return null;
    const base = [...((editTest.ir.assertions ?? []) as IrAssertion[])];
    const uiIdx = base.findIndex((a) => a.type === "ui");
    if (assertionText.trim()) {
      const uiPatch: IrAssertion = {
        ...(uiIdx >= 0 ? base[uiIdx]! : { id: "review-assertion", type: "ui", oracle: "human-approved" }),
        type: "ui",
        contains: assertionText,
        oracle: "human-approved",
      };
      if (uiIdx >= 0) base[uiIdx] = uiPatch;
      else base.unshift(uiPatch);
    } else {
      for (let i = base.length - 1; i >= 0; i -= 1) {
        if (base[i]!.type === "ui") base.splice(i, 1);
      }
    }

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

    const built = buildProviderAssertion(providerDraft);
    if (!built.ok) return null;
    if (built.assertion) {
      const idx = base.findIndex((a) => a.type === built.assertion!.type);
      if (idx >= 0) base[idx] = built.assertion as IrAssertion;
      else base.push(built.assertion as IrAssertion);
    } else {
      for (const t of ["db", "agent"] as const) {
        const idx = base.findIndex((a) => a.type === t);
        if (idx >= 0) base.splice(idx, 1);
      }
    }

    return { ...editTest.ir, assertions: base, steps: reviewSteps };
  };

  const trialRunReview = async () => {
    if (!editTest) return;
    const ir = buildReviewIr();
    if (!ir) {
      notify("请修正 API expect / Provider 后再试跑");
      return;
    }
    if (reviewSteps.length === 0) {
      notify("至少保留一个步骤");
      return;
    }
    setTrialRunning(true);
    setTrialResult(null);
    try {
      const res = await api<{ run: StoredRun; trial?: boolean }>(`/api/tests/${editTest.id}/trial-run`, {
        method: "POST",
        body: JSON.stringify({ ir }),
      });
      const run = res.run;
      setTrialResult(run);
      await refresh();
      if (run.status === "passed") {
        notify("试跑通过（未写入批准状态）", "success");
        return;
      }
      notify("试跑未通过，可查看下方证据或诊断", "error");
      void openDiagnose(run);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setTrialRunning(false);
    }
  };

  const validateProviderDraft = async () => {
    const built = buildProviderAssertion(providerDraft);
    if (!providerDraft.enabled) {
      setProviderFeedback({ issues: [] });
      notify("未启用 Provider 断言");
      return;
    }
    if (!built.ok || !built.assertion) {
      notify(built.error ?? "Provider 断言无效");
      return;
    }
    setProviderBusy(true);
    try {
      const res = await api<{ ok: boolean; issues: Array<{ path: string; message: string }> }>(
        "/api/assertions/validate",
        { method: "POST", body: JSON.stringify({ assertions: [built.assertion] }) },
      );
      setProviderFeedback((f) => ({ ...f, issues: res.issues }));
      notify(res.ok ? "校验通过" : "校验未通过");
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setProviderBusy(false);
    }
  };

  const testProviderConnection = async () => {
    if (!providerDraft.enabled) return;
    setProviderBusy(true);
    try {
      const res = await api<ProviderFeedback["connection"] & { ok: boolean; message: string }>(
        "/api/assertions/test-connection",
        {
          method: "POST",
          body: JSON.stringify({
            kind: providerDraft.type,
            configRef: providerDraft.configRef,
          }),
        },
      );
      setProviderFeedback((f) => ({ ...f, connection: res }));
      notify(res.ok ? "连接正常" : res.message);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setProviderBusy(false);
    }
  };

  const previewProviderDraft = async () => {
    const built = buildProviderAssertion(providerDraft);
    if (!providerDraft.enabled || !built.ok || !built.assertion) {
      notify(built.error ?? "请先填写 Provider 断言");
      return;
    }
    setProviderBusy(true);
    try {
      const res = await api<{ ok: boolean; message?: string; preview?: unknown }>(
        "/api/assertions/preview",
        {
          method: "POST",
          body: JSON.stringify({
            assertion: built.assertion,
            traceRef: providerDraft.traceRef,
          }),
        },
      );
      if (res.ok) {
        setProviderFeedback((f) => ({ ...f, preview: res.preview, previewError: undefined }));
        notify("预览已更新");
      } else {
        setProviderFeedback((f) => ({ ...f, previewError: res.message ?? "预览失败" }));
        notify(res.message ?? "预览失败");
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setProviderBusy(false);
    }
  };

  const reviewIrValid = () => {
    if (apiExpectJson.trim()) {
      try {
        JSON.parse(apiExpectJson);
      } catch {
        return false;
      }
    }
    if (providerDraft.enabled) {
      const built = buildProviderAssertion(providerDraft);
      if (!built.ok) return false;
    }
    const ir = buildReviewIr();
    return Boolean(ir && (ir.assertions?.length ?? 0) > 0);
  };

  const saveDraft = async () => {
    if (!editTest) return;
    const ir = buildReviewIr();
    if (!ir || !reviewIrValid()) {
      notify("请填写 UI 断言、API expect，或合法的 Provider 断言");
      return;
    }
    await api(`/api/tests/${editTest.id}`, {
      method: "PUT",
      body: JSON.stringify({ ir, intentSummary: reviewIntent }),
    });
    setEditTest(null);
    setReviewDirty(false);
    notify("草稿已保存", "success");
    await refresh();
  };

  const saveAndApprove = async () => {
    if (!editTest) return;
    const ir = buildReviewIr();
    if (!ir || !reviewIrValid()) {
      notify("请填写 UI 断言、API expect，或合法的 Provider 断言");
      return;
    }
    if (approvalInfo?.approvalTokenRequired) {
      try {
        if (!localStorage.getItem("testpilot-approval-token")?.trim()) {
          notify("服务端要求审批令牌：请在审阅区填写 TESTPILOT_APPROVAL_TOKEN");
          return;
        }
      } catch {
        notify("无法读取本地审批令牌");
        return;
      }
    }
    if (approvalInfo?.approvalActors?.length && !approvalActor.trim()) {
      notify("请选择或填写审批人标识");
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
        body: JSON.stringify({
          irHash: saved.irHash,
          assertionConfigHash: saved.currentAssertionConfigHash ?? saved.assertionConfigHash,
        }),
      });
      setEditTest(null);
      setReviewDirty(false);
      notify("已保存并批准", "success");
      await refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const deleteDraft = async () => {
    if (!editTest) return;
    if (!window.confirm(`删除草稿「${editTest.title}」？此操作不可撤销。`)) return;
    try {
      await api(`/api/tests/${editTest.id}`, { method: "DELETE" });
      setEditTest(null);
      setReviewDirty(false);
      notify("草稿已删除", "success");
      await refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "error");
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

  const statusItems: Array<{
    key: string;
    text: string;
    tone: "warn" | "bad" | "muted";
    onClick?: () => void;
  }> = [];
  if (draftCount > 0) {
    statusItems.push({
      key: "draft",
      text: `${draftCount} 条草稿待审阅`,
      tone: "warn",
      onClick: () => {
        setTestFilter("draft");
        setView("tests");
      },
    });
  }
  if ((summary?.weakApprovedCount ?? 0) > 0) {
    statusItems.push({
      key: "weak",
      text: `${summary!.weakApprovedCount} 条弱断言`,
      tone: "bad",
      onClick: () => {
        setTestFilter("weak");
        setView("tests");
      },
    });
  }
  if (demoOk === false) statusItems.push({ key: "demo", text: "练习应用未启动（:4173）", tone: "bad" });
  if (pilotOk === false) statusItems.push({ key: "pilot", text: "试点环境不可达", tone: "bad" });
  if (pilotSecrets === false) statusItems.push({ key: "secrets", text: "试点凭据未配置", tone: "warn" });
  if (llmInfo && !llmInfo.enabled) {
    statusItems.push({
      key: "llm",
      text: llmInfo.error ? `LLM 配置无效：${llmInfo.error}` : "LLM 未启用（可选）",
      tone: "muted",
    });
  } else if (llmInfo?.lastError) {
    statusItems.push({ key: "llm-error", text: `最近 LLM 调用失败：${llmInfo.lastError}`, tone: "warn" });
  }

  const pendingIr = editTest ? buildReviewIr() : null;
  const pendingAssertions = (pendingIr?.assertions ?? editTest?.ir.assertions ?? []) as IrAssertion[];

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
          <button type="button" className={view === "audit" ? "active" : ""} onClick={() => setView("audit")}>
            审计
          </button>
        </nav>
      </aside>

      <div className="content-column">
      {statusItems.length > 0 && (
        <div className="status-strip" role="status">
          {statusItems.map((item) =>
            item.onClick ? (
              <button key={item.key} type="button" className={`status-chip ${item.tone}`} onClick={item.onClick}>
                {item.text}
              </button>
            ) : (
              <span key={item.key} className={`status-chip ${item.tone}`}>
                {item.text}
              </span>
            ),
          )}
        </div>
      )}

      <main>
        {view === "home" && (
          <section className="hero">
            <p className="hero-eyebrow">TestPilot · 可信回归</p>
            <h1>把手工回归，变成可信任的自动化。</h1>
            <p className="hero-lede">
              {approvedCount ?? "…"} 条已批准用例
              {approvedPilot > 0 ? `（试点 ${approvedPilot} · 练习 ${approvedDemo}）` : ""}
              。先审阅草稿确认断言，再一键回归；每条通过的用例都能给出 HTTP、DB 或 Agent 证据。
            </p>
            <div className="hero-actions">
              {draftCount > 0 ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setTestFilter("draft");
                    setView("tests");
                  }}
                >
                  审阅 {draftCount} 条草稿
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={loading || (demoOk === false && pilotOk === false)}
                  onClick={runAll}
                >
                  {loading ? "运行中…" : "运行全部回归"}
                </button>
              )}
              {draftCount > 0 && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={loading || (demoOk === false && pilotOk === false)}
                  onClick={runAll}
                >
                  {loading ? "运行中…" : "运行全部回归"}
                </button>
              )}
              <button type="button" className="btn btn-secondary" onClick={() => setView("create")}>
                创建用例
              </button>
            </div>
            <div className="hero-links">
              <a className="link-quiet" href={demoUrl} target="_blank" rel="noreferrer">
                练习应用 ↗
              </a>
              <a
                className="link-quiet"
                href={pilotUrl ?? "#"}
                onClick={(e) => {
                  if (!pilotUrl) {
                    e.preventDefault();
                    notify("请在本机 .env 配置 TESTPILOT_PILOT_BASE_URL");
                  }
                }}
                target="_blank"
                rel="noreferrer"
              >
                试点地址 ↗
              </a>
              {llmInfo?.enabled ? (
                <span className="link-quiet">LLM：{llmInfo.provider}/{llmInfo.model}（仅草稿与诊断）</span>
              ) : null}
            </div>
            <div className="stat-grid">
              <div className="stat-card">
                <span className="stat-label">已批准</span>
                <strong>{approvedCount ?? "…"}</strong>
                <span className="stat-sub">
                  试点 {approvedPilot} · 练习 {approvedDemo}
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-label">通过率</span>
                <strong>{summary && summary.runCount > 0 ? `${Math.round(summary.passRate * 100)}%` : "—"}</strong>
                <span className="stat-sub">最近 {summary?.runCount ?? 0} 次运行</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">平均耗时</span>
                <strong>{summary && summary.runCount > 0 ? `${summary.avgDurationMs} ms` : "—"}</strong>
                <span className="stat-sub">
                  {summary?.lastBatchDurationMs != null
                    ? `上批 ${Math.round(summary.lastBatchDurationMs / 1000)}s`
                    : "尚无批次"}
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-label">弱断言</span>
                <strong className={(summary?.weakApprovedCount ?? 0) > 0 ? "stat-bad" : "stat-ok"}>
                  {summary?.weakApprovedCount ?? 0}
                </strong>
                <span className="stat-sub">
                  {summary?.multiAttemptRuns
                    ? `重试 ${summary.multiAttemptRuns} · flake 恢复 ${Math.round((summary.flakeRecoveryRate ?? 0) * 100)}%`
                    : "无重试记录"}
                </span>
              </div>
            </div>
            {summary?.minutesSavedVsBaseline != null && summary.minutesSavedVsBaseline > 0 ? (
              <p className="stat-note">
                人工基线约 {summary.pilotBaselineMinutes} 分钟 · 本批节省约 {summary.minutesSavedVsBaseline} 分钟
              </p>
            ) : null}
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
                    <h3>
                      {r.testTitle}
                      {r.trial ? <span className="badge trial">试跑</span> : null}
                    </h3>
                    <p>
                      {new Date(r.completedAt).toLocaleString()} · {r.metrics?.durationMs ?? "—"} ms
                      {(r.metrics?.attemptCount ?? 1) > 1
                        ? ` · ${r.metrics?.attemptCount} 次尝试${r.metrics?.flakeRecovery ? "（flake 恢复）" : ""}`
                        : ""}
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
        {view === "audit" && (
          <section>
            <h2 className="section-title">审批与审计</h2>
            <p className="section-lede">
              批准请求会携带审批人标识{approvalInfo?.approvalTokenRequired ? "与审批令牌" : ""}；服务端写入{" "}
              <code>data/audit.jsonl</code>。
            </p>
            <div className="card-panel">
              <h3>审批身份</h3>
              <div className="audit-identity-fields">
                <div className="field">
                  <label>审批人（x-testpilot-actor）</label>
                  {approvalInfo?.approvalActors?.length ? (
                    <select value={approvalActor} onChange={(e) => persistApprovalActor(e.target.value)}>
                      <option value="">请选择…</option>
                      {approvalInfo.approvalActors.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={approvalActor}
                      onChange={(e) => persistApprovalActor(e.target.value)}
                      placeholder="例如 qa-lead"
                    />
                  )}
                </div>
                {approvalInfo?.approvalTokenRequired ? (
                  <div className="field">
                    <label>审批令牌（仅保存在本机浏览器）</label>
                    <input
                      type="password"
                      value={approvalTokenInput}
                      onChange={(e) => persistApprovalToken(e.target.value)}
                      placeholder="与 .env 中 TESTPILOT_APPROVAL_TOKEN 一致"
                      autoComplete="off"
                    />
                    <p className="hint-inline">
                      {approvalTokenInput.trim() ? "已保存到本机浏览器。" : "未填写时无法批准。"}
                    </p>
                  </div>
                ) : (
                  <p className="hint-inline">服务端未启用审批令牌；本机默认以审批人标识记录。</p>
                )}
              </div>
            </div>
            <div className="card-panel">
              <h3>最近批准</h3>
              {auditEntries.length > 0 ? (
                <ul className="audit-log-list">
                  {auditEntries.map((e) => (
                    <li key={`${e.at}-${e.testId}-${e.actor}`}>
                      <span>{new Date(e.at).toLocaleString()}</span>
                      <span className="audit-log-actor">{e.actor}</span>
                      <span>{e.title}</span>
                      <span className="audit-log-hash">{e.irHash.slice(0, 8)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="hint-inline">尚无审批审计记录。</p>
              )}
            </div>
          </section>
        )}

      </main>
      </div>

      {editTest && (
        <div className="overlay" onClick={closeReview}>
          <div className="sheet sheet-wide sheet-review" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="review-title">
            <header className="sheet-review-header">
              <div className="sheet-review-header-row">
                <div>
                  <h2 id="review-title">审阅用例</h2>
                  <p className="sheet-review-subtitle">{editTest.title}</p>
                </div>
                <div className="sheet-header-actions">
                  {editTest.approvalStatus === "draft" && (
                    <button type="button" className="btn-mini danger" onClick={() => void deleteDraft()}>
                      删除草稿
                    </button>
                  )}
                  <button type="button" className="sheet-close" aria-label="关闭" onClick={closeReview}>
                    ×
                  </button>
                </div>
              </div>
              <p className="hint-inline sheet-review-meta">
                {reviewSteps.length} 个步骤 · 来源 {editTest.sourceChannel ?? "未知"}
                {editTest.irHash ? ` · IR ${editTest.irHash.slice(0, 8)}` : ""}
                {editTest.currentAssertionConfigHash ? ` · 配置 ${editTest.currentAssertionConfigHash}` : ""}
                {editTest.configHashStale ? " · 配置已变化，需重新批准" : ""}
                {reviewDirty ? " · 有未保存修改" : ""}
              </p>
            </header>
            <div className="sheet-review-body">
              {pilotScopeNote && isPilotTest(editTest) && <p className="hint-inline">试点：{pilotScopeNote}</p>}
              {editTest.plannerNotes && editTest.plannerNotes.length > 0 && (
                <ul className="diagnose-list planner-notes">
                  {editTest.plannerNotes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              <StepEditorPanel steps={reviewSteps} onChange={updateReviewSteps} />

              <section className="review-section">
                <div className="review-section-head">
                  <h3>2 · 断言</h3>
                  <span className="review-count">{pendingAssertions.length} 条</span>
                </div>
                {pendingAssertions.length > 0 ? (
                  <ul className="step-list assertion-list">
                    {pendingAssertions.map((a, i) => (
                      <li key={a.id ?? i}>{summarizeAssertion(a, i)}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="empty-note">还没有断言；至少需要一条才能保存或批准。</p>
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
                    onChange={(e) => {
                      setReviewIntent(e.target.value);
                      markReviewDirty();
                    }}
                  />
                </div>
                <div className="field">
                  <label>页面应包含（UI 断言）</label>
                  <p className="hint-inline">
                    {assertionHelp || "填写操作成功后页面上可见的稳定文案；留空则只保留 API / 业务断言。"}
                  </p>
                  <input
                    value={assertionText}
                    onChange={(e) => {
                      setAssertionText(e.target.value);
                      markReviewDirty();
                    }}
                  />
                  {assertionSuggestions.length > 0 && (
                    <div className="chips">
                      {assertionSuggestions.map((s) => (
                        <button
                          key={s}
                          type="button"
                          className="chip"
                          onClick={() => {
                            setAssertionText(s);
                            markReviewDirty();
                          }}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="field field-last">
                  <label>API expect（JSON，可选）</label>
                  <p className="hint-inline">
                    支持 <code>statusCode</code>、<code>jsonBody</code>（请求体字段）、
                    <code>requestBodyContains</code>（子串）。例：{" "}
                    {`{"statusCode":409,"jsonBody":{"error":"duplicate"}}`}
                  </p>
                  <textarea
                    className="textarea"
                    rows={4}
                    value={apiExpectJson}
                    onChange={(e) => {
                      setApiExpectJson(e.target.value);
                      markReviewDirty();
                    }}
                    placeholder='{"statusCode": 201, "requestBodyContains": "@example.com"}'
                  />
                </div>
              </section>

              <section className="review-section">
                <div className="review-section-head">
                  <h3>3 · 业务断言</h3>
                  <span className="review-count">可选</span>
                </div>
                <AssertionProviderPanel
                  catalog={assertionCatalog}
                  draft={providerDraft}
                  onDraftChange={(next) => {
                    setProviderDraft(next);
                    markReviewDirty();
                  }}
                  feedback={providerFeedback}
                  busy={providerBusy}
                  onValidate={() => void validateProviderDraft()}
                  onTestConnection={() => void testProviderConnection()}
                  onPreview={() => void previewProviderDraft()}
                />
              </section>

              {(approvalInfo?.approvalTokenRequired || approvalInfo?.approvalActors?.length) && (
                <section className="review-section approval-box">
                  <div className="review-section-head">
                    <h3>4 · 批准身份</h3>
                  </div>
                  <p className="hint-inline">
                    批准将记录为 <strong>{approvalActor.trim() || "（未设置审批人）"}</strong>。
                  </p>
                  <div className="audit-identity-fields">
                    <div className="field">
                      <label>审批人</label>
                      {approvalInfo.approvalActors?.length ? (
                        <select value={approvalActor} onChange={(e) => persistApprovalActor(e.target.value)}>
                          <option value="">请选择…</option>
                          {approvalInfo.approvalActors.map((a) => (
                            <option key={a} value={a}>
                              {a}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={approvalActor}
                          onChange={(e) => persistApprovalActor(e.target.value)}
                          placeholder="例如 qa-lead"
                        />
                      )}
                    </div>
                    {approvalInfo.approvalTokenRequired ? (
                      <div className="field">
                        <label>审批令牌</label>
                        <input
                          type="password"
                          value={approvalTokenInput}
                          onChange={(e) => persistApprovalToken(e.target.value)}
                          placeholder="与 .env 中 TESTPILOT_APPROVAL_TOKEN 一致"
                          autoComplete="off"
                        />
                        <p className="hint-inline">
                          {approvalTokenInput.trim() ? "已保存到本机浏览器。" : "未填写时无法批准。"}
                        </p>
                      </div>
                    ) : null}
                  </div>
                  <p className="hint-inline">也可以在「审计」页设置一次，之后自动复用。</p>
                </section>
              )}

            </div>
            <footer className="sheet-review-footer">
              {trialResult && (
                <section className={`trial-result ${trialResult.status === "passed" ? "ok" : "bad"}`}>
                  <div className="trial-result-head">
                    <strong>{trialResult.status === "passed" ? "试跑通过" : "试跑未通过"}</strong>
                    <span>
                      {trialResult.metrics?.durationMs ?? "—"} ms · {trialResult.metrics?.attemptCount ?? 1} 次尝试
                      {trialResult.metrics?.flakeRecovery ? "（flake 恢复）" : ""}
                    </span>
                  </div>
                  {trialResult.assertions.find((a) => !a.passed)?.message ? (
                    <p className="diagnose-msg">{trialResult.assertions.find((a) => !a.passed)?.message}</p>
                  ) : null}
                  <div className="trial-result-links">
                    <a className="btn-mini" href={`/api/runs/${trialResult.runId}/artifacts/trace.zip`}>
                      Trace
                    </a>
                    <a className="btn-mini" href={`/api/runs/${trialResult.runId}/artifacts/network.json`}>
                      网络
                    </a>
                    {failureScreenshotPath(trialResult) && (
                      <a
                        className="btn-mini"
                        href={failureScreenshotPath(trialResult)!}
                        target="_blank"
                        rel="noreferrer"
                      >
                        截图
                      </a>
                    )}
                  </div>
                </section>
              )}
              <div className="sheet-actions">
                <button type="button" className="btn btn-primary" onClick={saveAndApprove} disabled={trialRunning}>
                  保存并批准
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={trialRunning || reviewSteps.length === 0}
                  onClick={() => void trialRunReview()}
                >
                  {trialRunning ? "试跑中…" : "试跑草稿"}
                </button>
                <button type="button" className="btn btn-tertiary" onClick={saveDraft} disabled={trialRunning}>
                  仅保存草稿
                </button>
                <button type="button" className="btn btn-tertiary" onClick={applySuggest}>
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
                    : "回归执行不调用 LLM；在 .env 配置 TESTPILOT_LLM_API_KEY（见 .env.example）。"}
                </p>
              </>
            )}
            <button type="button" className="btn btn-secondary" onClick={() => setDiagnoseRun(null)}>
              关闭
            </button>
          </div>
        </div>
      )}

      {toast && <div className={`toast toast-${toast.kind}`}>{toast.message}</div>}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import {
  api,
  type DetectionJob,
  type DetectionRecord,
  type DetectionTarget,
  type ExplorationSuggestion,
  type FileMediaScenarioKind,
  type MechanismPlanResponse,
  type ReadOnlySuiteJob,
  type ReadOnlySuiteResult,
  type RealtimeScenarioKind,
  type RiskCategory,
  type RiskItem,
  type RiskReport,
  type StoredRun,
  type StoredTest,
} from "./api";
import { CAPABILITY_LABELS, REQUIREMENT_LABELS, SIGNAL_LABELS } from "./capabilityLabels";

type Props = {
  demoUrl: string;
  pilotIntakeUrl: string | null;
  demoReachable: boolean | null;
  pilotReachable: boolean | null;
  realUrl: string | null;
  realReachable: boolean | null;
  realSecretsConfigured: boolean | null;
  onOpenReview: (testId: string) => void;
  onCreateDraftFromRisk?: (risk: RiskItem) => void;
  onRefresh?: () => void;
  onOpenBatch?: (batchId: string) => void;
};

const READ_ONLY_SUITE_STATUS_LABELS: Record<ReadOnlySuiteResult["status"], string> = {
  passed: "通过",
  failed: "失败",
  error: "错误",
};

const RISK_CATEGORY_LABELS: Record<RiskCategory, string> = {
  "data-lifecycle": "数据生命周期",
  authz: "权限",
  "money-order": "金额/订单",
  realtime: "实时",
  concurrency: "并发",
  validation: "校验",
  privacy: "隐私",
  reliability: "可靠性",
  compatibility: "兼容性",
  coverage: "覆盖",
};

const RISK_SEVERITY_LABELS = { high: "高", medium: "中", low: "低" } as const;

const SCENARIO_LABELS: Record<FileMediaScenarioKind, string> = {
  happy: "正常上传",
  "invalid-type": "类型不符",
  oversize: "超过大小",
};

const REALTIME_SCENARIO_LABELS: Record<RealtimeScenarioKind, string> = {
  text: "文本送达",
  dedupe: "多消息去重",
  oversize: "超长消息",
  order: "严格顺序",
  image: "图片消息",
  reconnect: "断线重连",
};

type MechanismContextForm = {
  pagePath: string;
  uploadRef: string;
  fileName: string;
  uploadRequestRef: string;
  uploadTarget: string;
  submitTarget: string;
  listTarget: string;
  invalidTypeRef: string;
  invalidTypeName: string;
  oversizeRef: string;
  oversizeName: string;
  cleanupPath: string;
  cleanupMethod: string;
  cleanupIdField: string;
};

type FileMediaPlanContext = Extract<
  MechanismPlanResponse["mechanisms"][number],
  { id: "file-media" }
>["context"];

function contextFromPlan(ctx: FileMediaPlanContext | undefined): MechanismContextForm {
  return {
    pagePath: ctx?.pagePath ?? "/files",
    uploadRef: ctx?.uploadRef ?? "fixture.samplePng",
    fileName: ctx?.fileName ?? "sample.png",
    uploadRequestRef: ctx?.uploadRequestRef ?? "files-upload",
    uploadTarget: ctx?.uploadTarget ?? "file-input",
    submitTarget: ctx?.submitTarget ?? "file-upload-submit",
    listTarget: ctx?.listTarget ?? "file-list",
    invalidTypeRef: ctx?.invalidTypeRef ?? "",
    invalidTypeName: ctx?.invalidTypeName ?? "",
    oversizeRef: ctx?.oversizeRef ?? "",
    oversizeName: ctx?.oversizeName ?? "",
    cleanupPath: ctx?.cleanupPath ?? "",
    cleanupMethod: ctx?.cleanupMethod ?? "DELETE",
    cleanupIdField: ctx?.cleanupIdField ?? "id",
  };
}

type RealtimeMechanismContextForm = {
  pagePath: string;
  composerTestId: string;
  sendTestId: string;
  listTestId: string;
  wsUrlIncludes: string;
  text: string;
  senderActor: string;
  receiverActor: string;
  messageCount: string;
  maxLength: string;
  overlongText: string;
  imageTestId: string;
  imageButtonTestId: string;
  reconnectQuery: string;
  reconnectCountTestId: string;
};

function realtimeContextFromPlan(
  ctx:
    | Extract<MechanismPlanResponse["mechanisms"][number], { id: "realtime-messaging" }>["context"]
    | undefined,
): RealtimeMechanismContextForm {
  return {
    pagePath: ctx?.pagePath ?? "/chat",
    composerTestId: ctx?.composerTestId ?? "chat-composer",
    sendTestId: ctx?.sendTestId ?? "chat-send",
    listTestId: ctx?.listTestId ?? "chat-list",
    wsUrlIncludes: ctx?.wsUrlIncludes ?? "/ws/chat",
    text: ctx?.text ?? "测试消息",
    senderActor: ctx?.senderActor ?? "sender",
    receiverActor: ctx?.receiverActor ?? "receiver",
    messageCount:
      ctx?.messageCount !== undefined && ctx.messageCount >= 2 ? String(ctx.messageCount) : "3",
    maxLength: ctx?.maxLength !== undefined ? String(ctx.maxLength) : "200",
    overlongText: ctx?.overlongText ?? "",
    imageTestId: ctx?.imageTestId ?? "chat-image",
    imageButtonTestId: ctx?.imageButtonTestId ?? "chat-send-image",
    reconnectQuery: ctx?.reconnectQuery ?? "reconnect=1&dropAfter=1",
    reconnectCountTestId: ctx?.reconnectCountTestId ?? "chat-reconnects",
  };
}

function realtimeContextPayload(form: RealtimeMechanismContextForm): Record<string, string> {
  return {
    pagePath: form.pagePath,
    composerTestId: form.composerTestId,
    sendTestId: form.sendTestId,
    listTestId: form.listTestId,
    wsUrlIncludes: form.wsUrlIncludes,
    text: form.text,
    senderActor: form.senderActor,
    receiverActor: form.receiverActor,
    messageCount: form.messageCount.trim() || "3",
    maxLength: form.maxLength.trim() || "200",
    ...(form.overlongText.trim() ? { overlongText: form.overlongText.trim() } : {}),
    imageTestId: form.imageTestId.trim() || "chat-image",
    imageButtonTestId: form.imageButtonTestId.trim() || "chat-send-image",
    reconnectQuery: form.reconnectQuery.trim() || "reconnect=1&dropAfter=1",
    reconnectCountTestId: form.reconnectCountTestId.trim() || "chat-reconnects",
  };
}

function contextPayload(form: MechanismContextForm): Record<string, string> {
  const out: Record<string, string> = {
    pagePath: form.pagePath,
    uploadRef: form.uploadRef,
    fileName: form.fileName,
    uploadRequestRef: form.uploadRequestRef,
    uploadTarget: form.uploadTarget,
    submitTarget: form.submitTarget,
    listTarget: form.listTarget,
  };
  if (form.invalidTypeRef.trim()) out.invalidTypeRef = form.invalidTypeRef.trim();
  if (form.invalidTypeName.trim()) out.invalidTypeName = form.invalidTypeName.trim();
  if (form.oversizeRef.trim()) out.oversizeRef = form.oversizeRef.trim();
  if (form.oversizeName.trim()) out.oversizeName = form.oversizeName.trim();
  if (form.cleanupPath.trim()) {
    out.cleanupPath = form.cleanupPath.trim();
    out.cleanupMethod = form.cleanupMethod.trim() || "DELETE";
    out.cleanupIdField = form.cleanupIdField.trim() || "id";
  }
  return out;
}

const TARGET_LABELS: Record<DetectionTarget, string> = {
  demo: "练习环境",
  pilot: "业务试点",
  custom: "自定义环境",
  real: "真实环境",
};

function confidenceClass(confidence: number): string {
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.6) return "mid";
  return "low";
}

export function SystemProfileView({
  demoUrl,
  pilotIntakeUrl,
  demoReachable,
  pilotReachable,
  realUrl,
  realReachable,
  realSecretsConfigured,
  onOpenReview,
  onCreateDraftFromRisk,
  onRefresh,
  onOpenBatch,
}: Props) {
  const [target, setTarget] = useState<DetectionTarget>("demo");
  const [customUrl, setCustomUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [record, setRecord] = useState<DetectionRecord | null>(null);
  const [recent, setRecent] = useState<DetectionRecord[]>([]);
  const [mechanismPlan, setMechanismPlan] = useState<MechanismPlanResponse | null>(null);
  const [mechContext, setMechContext] = useState<MechanismContextForm>(contextFromPlan(undefined));
  const [mechScenario, setMechScenario] = useState<FileMediaScenarioKind>("happy");
  const [mechTrial, setMechTrial] = useState(false);
  const [mechSaving, setMechSaving] = useState(false);
  const [mechError, setMechError] = useState<string | null>(null);
  const [mechSaved, setMechSaved] = useState<{ title: string; testId: string } | null>(null);
  const mechInitRef = useRef<string | null>(null);
  const [realtimeContext, setRealtimeContext] = useState<RealtimeMechanismContextForm>(
    realtimeContextFromPlan(undefined),
  );
  const [realtimeScenario, setRealtimeScenario] = useState<RealtimeScenarioKind>("text");
  const [realtimeTrial, setRealtimeTrial] = useState(false);
  const [realtimeSaving, setRealtimeSaving] = useState(false);
  const [realtimeError, setRealtimeError] = useState<string | null>(null);
  const [realtimeSaved, setRealtimeSaved] = useState<{ title: string; testId: string } | null>(null);
  const [risk, setRisk] = useState<RiskReport | null>(null);
  const [riskLoading, setRiskLoading] = useState(false);
  const [riskError, setRiskError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<ExplorationSuggestion[] | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [readOnlySuiteBusy, setReadOnlySuiteBusy] = useState(false);
  const [readOnlySuiteJob, setReadOnlySuiteJob] = useState<ReadOnlySuiteJob | null>(null);
  const [readOnlySuiteError, setReadOnlySuiteError] = useState<string | null>(null);
  const [readOnlySuiteBatchMsg, setReadOnlySuiteBatchMsg] = useState<string | null>(null);
  const [readOnlySuiteRunBusy, setReadOnlySuiteRunBusy] = useState(false);

  useEffect(() => {
    setRisk(null);
    setRiskError(null);
    setSuggestions(null);
    setSuggestError(null);
    const detectionId = record?.id;
    if (!detectionId) return;
    let cancelled = false;
    api<RiskReport>(`/api/detect/${detectionId}/risk-report`)
      .then((report) => {
        if (!cancelled) setRisk(report);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [record?.id]);

  const generateSuggestions = async () => {
    if (!record) return;
    setSuggestLoading(true);
    setSuggestError(null);
    try {
      const res = await api<{ suggestions: ExplorationSuggestion[] }>(
        `/api/detect/${record.id}/explore-suggestions`,
      );
      setSuggestions(res.suggestions);
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : String(err));
    } finally {
      setSuggestLoading(false);
    }
  };

  const generateRiskReport = async () => {
    if (!record) return;
    setRiskLoading(true);
    setRiskError(null);
    try {
      setRisk(await api<RiskReport>(`/api/detect/${record.id}/risk-report`, { method: "POST" }));
    } catch (err) {
      setRiskError(err instanceof Error ? err.message : String(err));
    } finally {
      setRiskLoading(false);
    }
  };

  const loadRecent = async () => {
    try {
      const res = await api<{ detections: DetectionRecord[] }>("/api/detect");
      setRecent(res.detections);
    } catch {
      setRecent([]);
    }
  };

  useEffect(() => {
    void loadRecent();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setRecord(null);
    const params = new URLSearchParams({ target });
    if (target === "custom" && customUrl.trim()) params.set("url", customUrl.trim());
    api<{ record: DetectionRecord | null }>(`/api/detect/latest?${params.toString()}`)
      .then((res) => {
        if (!cancelled) setRecord(res.record);
      })
      .catch(() => {
        if (!cancelled) setRecord(null);
      });
    return () => {
      cancelled = true;
    };
    // customUrl is intentionally not a dependency: typing a URL should not probe storage.
  }, [target]);

  useEffect(() => {
    setMechContext(contextFromPlan(undefined));
    setMechScenario("happy");
    setMechTrial(false);
    setRealtimeContext(realtimeContextFromPlan(undefined));
    setRealtimeScenario("text");
    setRealtimeTrial(false);
  }, [record?.id]);

  useEffect(() => {
    if (!record || loading) {
      setMechanismPlan(null);
      return;
    }
    const hasMechanism = record.profile.capabilities.some(
      (c) => c.id === "file-media" || c.id === "realtime-messaging",
    );
    if (!hasMechanism) {
      setMechanismPlan(null);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({
      ...contextPayload(mechContext),
      ...realtimeContextPayload(realtimeContext),
    });
    api<MechanismPlanResponse>(`/api/detect/${record.id}/mechanisms?${params.toString()}`)
      .then((plan) => {
        if (cancelled) return;
        setMechanismPlan(plan);
        const fileMedia = plan.mechanisms.find((m) => m.id === "file-media");
        const realtime = plan.mechanisms.find((m) => m.id === "realtime-messaging");
        if (mechInitRef.current !== record.id) {
          mechInitRef.current = record.id;
          if (fileMedia && fileMedia.id === "file-media") {
            setMechContext(contextFromPlan(fileMedia.context));
          }
          if (realtime && realtime.id === "realtime-messaging") {
            setRealtimeContext(realtimeContextFromPlan(realtime.context));
          }
        }
        if (
          fileMedia &&
          fileMedia.id === "file-media" &&
          fileMedia.scenarios.length &&
          !fileMedia.scenarios.some((s) => s.kind === mechScenario)
        ) {
          setMechScenario(fileMedia.scenarios[0]!.kind);
        }
        if (
          realtime &&
          realtime.id === "realtime-messaging" &&
          realtime.scenarios.length &&
          !realtime.scenarios.some((s) => s.kind === realtimeScenario)
        ) {
          setRealtimeScenario(realtime.scenarios[0]!.kind);
        }
      })
      .catch(() => {
        if (!cancelled) setMechanismPlan(null);
      });
    return () => {
      cancelled = true;
    };
  }, [record?.id, record?.profile.capabilities, loading, mechContext, realtimeContext, realtimeScenario]);

  useEffect(() => {
    setMechSaved(null);
    setMechError(null);
    setRealtimeSaved(null);
    setRealtimeError(null);
  }, [record?.id]);

  useEffect(() => {
    setReadOnlySuiteBusy(false);
    setReadOnlySuiteJob(null);
    setReadOnlySuiteError(null);
    setReadOnlySuiteBatchMsg(null);
    setReadOnlySuiteRunBusy(false);
  }, [record?.id]);

  const startReadOnlySuite = async () => {
    if (!record) return;
    setReadOnlySuiteBusy(true);
    setReadOnlySuiteError(null);
    setReadOnlySuiteBatchMsg(null);
    setReadOnlySuiteJob(null);
    try {
      const { jobId } = await api<{ jobId: string; total: number }>(
        `/api/detect/${record.id}/read-only-suite`,
        { method: "POST", body: JSON.stringify({ limit: 8 }) },
      );
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const job = await api<ReadOnlySuiteJob>(`/api/read-only-suite/jobs/${jobId}`);
        setReadOnlySuiteJob(job);
        if (job.status !== "running") {
          if (job.status === "failed") {
            setReadOnlySuiteError(job.error ?? "只读套件生成失败");
          }
          onRefresh?.();
          break;
        }
      }
    } catch (err) {
      setReadOnlySuiteError(err instanceof Error ? err.message : String(err));
    } finally {
      setReadOnlySuiteBusy(false);
    }
  };

  const runApprovedReadOnlySuite = async () => {
    const approvedIds = readOnlySuiteJob?.approvedIds ?? [];
    if (approvedIds.length === 0) return;
    setReadOnlySuiteRunBusy(true);
    setReadOnlySuiteError(null);
    setReadOnlySuiteBatchMsg(null);
    try {
      const res = await api<{ runs?: StoredRun[]; async?: boolean; jobId?: string }>(
        "/api/projects/default/runs",
        { method: "POST", body: JSON.stringify({ testIds: approvedIds }) },
      );
      if (res.async && res.jobId) {
        onOpenBatch?.(res.jobId);
        setReadOnlySuiteBatchMsg(`已启动批次 ${res.jobId}`);
      } else {
        const runs = res.runs ?? [];
        const passed = runs.filter((r) => r.status === "passed").length;
        setReadOnlySuiteBatchMsg(`运行完成：${passed}/${runs.length} 通过`);
        onRefresh?.();
      }
    } catch (err) {
      setReadOnlySuiteError(err instanceof Error ? err.message : String(err));
    } finally {
      setReadOnlySuiteRunBusy(false);
    }
  };

  const startDetection = async () => {
    if (target === "custom" && !customUrl.trim()) {
      setError("自定义环境需要填写 URL");
      return;
    }
    setLoading(true);
    setError(null);
    setStage("排队中");
    setElapsed(0);
    const startedAt = Date.now();
    try {
      const { jobId } = await api<{ jobId: string }>("/api/detect/jobs", {
        method: "POST",
        body: JSON.stringify({
          target,
          customUrl: target === "custom" ? customUrl.trim() : undefined,
        }),
      });
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const job = await api<DetectionJob>(`/api/detect/jobs/${jobId}`);
        setStage(job.stage);
        setElapsed(Math.round((Date.now() - startedAt) / 1000));
        if (job.status === "completed" && job.result) {
          setRecord(job.result);
          await loadRecent();
          break;
        }
        if (job.status === "failed") {
          throw new Error(job.error ?? "探测失败");
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setStage(null);
    }
  };

  const evidenceById = new Map(
    (record?.profile.signals ?? []).flatMap((signal) =>
      signal.evidence.map((evidence) => [evidence.id, evidence] as const),
    ),
  );
  const fileMediaMechanism = mechanismPlan?.mechanisms.find((m) => m.id === "file-media");
  const realtimeMechanism = mechanismPlan?.mechanisms.find((m) => m.id === "realtime-messaging");
  const hasFileMediaCapability = Boolean(
    record?.profile.capabilities.some((c) => c.id === "file-media"),
  );
  const hasRealtimeCapability = Boolean(
    record?.profile.capabilities.some((c) => c.id === "realtime-messaging"),
  );

  const createMechanismDraft = async () => {
    if (!record) return;
    setMechSaving(true);
    setMechError(null);
    setMechSaved(null);
    try {
      const res = await api<{ test: StoredTest; error?: string }>("/api/mechanisms/file-media/draft", {
        method: "POST",
        body: JSON.stringify({
          detectionId: record.id,
          scenario: mechScenario,
          context: contextPayload(mechContext),
          trial: mechTrial && record.target === "demo",
        }),
      });
      setMechSaved({ title: res.test.title, testId: res.test.id });
      onRefresh?.();
    } catch (e) {
      setMechError(e instanceof Error ? e.message : String(e));
    } finally {
      setMechSaving(false);
    }
  };

  const createRealtimeDraft = async () => {
    if (!record) return;
    setRealtimeSaving(true);
    setRealtimeError(null);
    setRealtimeSaved(null);
    try {
      const res = await api<{ test: StoredTest; error?: string }>(
        "/api/mechanisms/realtime-messaging/draft",
        {
          method: "POST",
          body: JSON.stringify({
            detectionId: record.id,
            scenario: realtimeScenario,
            context: realtimeContextPayload(realtimeContext),
            trial: realtimeTrial && record.target === "demo",
          }),
        },
      );
      setRealtimeSaved({ title: res.test.title, testId: res.test.id });
      onRefresh?.();
    } catch (e) {
      setRealtimeError(e instanceof Error ? e.message : String(e));
    } finally {
      setRealtimeSaving(false);
    }
  };

  const llmCapabilities = record?.profile.llmCapabilities ?? [];
  const capabilityCount = (record?.profile.capabilities.length ?? 0) + llmCapabilities.length;
  const llmQuestions = record?.profile.llmQuestions ?? [];
  const questionCount = (record?.profile.questions.length ?? 0) + llmQuestions.length;

  return (
    <section className="requirement-flow profile-view">
      <h2 className="section-title">系统画像</h2>
      <p className="section-lede">
        探测目标环境有哪些能力（增删改查、实时消息、文件、Agent 等），再按能力选择测试机制。探测默认只读，不会提交或删除数据。
      </p>

      <div className="card-panel">
        <fieldset className="env-picker">
          <legend>目标环境</legend>
          <label>
            <input
              type="radio"
              name="detect-env"
              checked={target === "demo"}
              onChange={() => setTarget("demo")}
            />
            练习环境 {demoReachable === false ? "（不可达）" : `(${demoUrl})`}
          </label>
          <label>
            <input
              type="radio"
              name="detect-env"
              checked={target === "pilot"}
              onChange={() => setTarget("pilot")}
              disabled={!pilotIntakeUrl}
            />
            业务试点{" "}
            {pilotReachable === false
              ? "（不可达）"
              : pilotIntakeUrl
                ? `(${pilotIntakeUrl})`
                : "（未配置）"}
          </label>
          <label>
            <input
              type="radio"
              name="detect-env"
              checked={target === "real"}
              onChange={() => setTarget("real")}
              disabled={!realUrl || !realSecretsConfigured}
            />
            真实环境{" "}
            {realReachable === false
              ? "（不可达）"
              : realUrl
                ? `(${realUrl})`
                : "（未配置）"}
            {realSecretsConfigured === false ? " · 缺少凭据" : ""}
          </label>
          <label>
            <input
              type="radio"
              name="detect-env"
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

        <div className="flow-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={loading}
            onClick={() => void startDetection()}
          >
            {loading ? "探测中…" : record ? "重新探测" : "开始探测"}
          </button>
          {record ? (
            <span className="stat-note">
              上次探测：{new Date(record.createdAt).toLocaleString()} · {record.profile.surfaces.length} 个页面
            </span>
          ) : null}
        </div>

        {loading ? (
          <div className="flow-progress" role="status" aria-live="polite">
            <div className="flow-progress-track">
              <span />
            </div>
            <p className="flow-progress-stage">
              {stage ?? "处理中"}… <span>{elapsed}s</span>
            </p>
            <p className="stat-note">探测会登录（试点）、枚举同源页面并采集 DOM / 网络 / WebSocket 信号。</p>
          </div>
        ) : null}
        {error ? <p className="diagnose-msg">{error}</p> : null}
      </div>

      {record ? (
        <>
          <div className="card-panel">
            <div className="profile-header">
              <div>
                <h3>{TARGET_LABELS[record.target]} · 能力图谱</h3>
                <p className="run-detail-meta">
                  {record.url} · {new Date(record.createdAt).toLocaleString()}
                </p>
              </div>
              <span className="badge">{capabilityCount} 项能力</span>
            </div>

            {record.profile.llmAnalysis ? (
              record.profile.llmAnalysis.used ? (
                <p className="profile-llm-note">
                  LLM 参与分析
                  {record.profile.llmAnalysis.model ? ` · ${record.profile.llmAnalysis.model}` : ""}
                  {record.profile.llmAnalysis.tokensUsed
                    ? ` · ${record.profile.llmAnalysis.tokensUsed} tokens`
                    : ""}
                </p>
              ) : (
                <p className="profile-llm-note muted">
                  本次未使用 LLM：{record.profile.llmAnalysis.error ?? "未知原因"}
                </p>
              )
            ) : null}

            {record.profile.llmSummary ? (
              <p className="profile-llm-summary">{record.profile.llmSummary}</p>
            ) : null}

            {capabilityCount === 0 ? (
              <p className="stat-note">
                没有识别到明确能力。可以再探测一次，或在创建页直接按需求生成草稿。
              </p>
            ) : (
              <div className="profile-grid">
                {record.profile.capabilities.map((capability) => {
                  const percent = Math.round(capability.confidence * 100);
                  return (
                    <article className="capability-card" key={capability.id}>
                      <header>
                        <strong>{CAPABILITY_LABELS[capability.id] ?? capability.id}</strong>
                        <span className={`confidence ${confidenceClass(capability.confidence)}`}>
                          {percent}%
                        </span>
                      </header>
                      {capability.source ? (
                        <span className={`capability-source ${capability.source}`}>
                          {capability.source === "hybrid" ? "规则 + LLM" : capability.source}
                        </span>
                      ) : null}
                      <div className="confidence-track" aria-hidden="true">
                        <span style={{ width: `${percent}%` }} />
                      </div>
                      <p className="stat-note">
                        {capability.signals
                          .map((signal) => SIGNAL_LABELS[signal] ?? signal)
                          .join(" · ")}
                      </p>
                      {capability.requires.length > 0 ? (
                        <p className="stat-note">
                          前置条件：
                          {capability.requires
                            .map((requirement) => REQUIREMENT_LABELS[requirement] ?? requirement)
                            .join("、")}
                        </p>
                      ) : null}
                      {capability.unknowns.map((unknown) => (
                        <p className="capability-unknown" key={unknown}>
                          {unknown}
                        </p>
                      ))}
                      {capability.testIdeas && capability.testIdeas.length > 0 ? (
                        <div className="capability-ideas">
                          <span>建议测试</span>
                          <ul>
                            {capability.testIdeas.map((idea) => (
                              <li key={idea}>{idea}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      <details className="capability-evidence">
                        <summary>证据 {capability.evidenceIds.length}</summary>
                        <ul>
                          {capability.evidenceIds.map((id) => {
                            const evidence = evidenceById.get(id);
                            return (
                              <li key={id}>
                                {evidence
                                  ? `${evidence.summary}${evidence.route ? ` · ${evidence.route}` : ""}`
                                  : id}
                              </li>
                            );
                          })}
                        </ul>
                      </details>
                    </article>
                  );
                })}
                {llmCapabilities.map((capability) => {
                  const percent = Math.round(capability.confidence * 100);
                  return (
                    <article className="capability-card llm" key={`llm-${capability.id}`}>
                      <header>
                        <strong>{capability.label}</strong>
                        <span className={`confidence ${confidenceClass(capability.confidence)}`}>
                          {percent}%
                        </span>
                      </header>
                      <span className="capability-source llm">LLM</span>
                      <div className="confidence-track" aria-hidden="true">
                        <span style={{ width: `${percent}%` }} />
                      </div>
                      <p className="stat-note">
                        <code>{capability.id}</code>
                      </p>
                      {capability.subCapabilities.length > 0 ? (
                        <p className="stat-note">
                          子能力：{capability.subCapabilities.join(" · ")}
                        </p>
                      ) : null}
                      {capability.unknowns.map((unknown) => (
                        <p className="capability-unknown" key={unknown}>
                          {unknown}
                        </p>
                      ))}
                      {capability.testIdeas.length > 0 ? (
                        <div className="capability-ideas">
                          <span>建议测试</span>
                          <ul>
                            {capability.testIdeas.map((idea) => (
                              <li key={idea}>{idea}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      <details className="capability-evidence">
                        <summary>证据 {capability.evidence.length}</summary>
                        <ul>
                          {capability.evidence.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </details>
                    </article>
                  );
                })}
              </div>
            )}
          </div>

          {record.target === "real" ? (
            <div className="card-panel read-only-suite-panel">
              <header className="mechanism-card-header">
                <h3>真实只读套件</h3>
              </header>
              <p className="stat-note">
                基于当前画像，为尚未被已批准用例覆盖的路由生成只读用例；自动试跑，强断言门禁通过后自动批准。不会写业务数据。
              </p>
              <div className="flow-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={readOnlySuiteBusy}
                  onClick={() => void startReadOnlySuite()}
                >
                  {readOnlySuiteBusy ? "生成并试跑中…" : "生成并试跑"}
                </button>
                {readOnlySuiteBusy && readOnlySuiteJob ? (
                  <span className="stat-note" role="status" aria-live="polite">
                    生成并试跑中…{readOnlySuiteJob.completed}/{readOnlySuiteJob.total}
                  </span>
                ) : readOnlySuiteBusy ? (
                  <span className="stat-note" role="status" aria-live="polite">
                    生成并试跑中…
                  </span>
                ) : null}
              </div>
              {readOnlySuiteError ? <p className="diagnose-msg">{readOnlySuiteError}</p> : null}
              {readOnlySuiteJob && readOnlySuiteJob.status !== "running" ? (
                <>
                  <p className="stat-note">
                    共 {readOnlySuiteJob.total} 条 · 自动批准 {readOnlySuiteJob.approvedIds.length} 条
                  </p>
                  {readOnlySuiteJob.results.length > 0 ? (
                    <ul className="explore-list read-only-suite-results">
                      {readOnlySuiteJob.results.map((item) => (
                        <li key={item.testId}>
                          <div className="explore-item-head">
                            <span className="badge subtle">
                              {READ_ONLY_SUITE_STATUS_LABELS[item.status]}
                            </span>
                            <strong>{item.title}</strong>
                            {item.approved ? <span className="badge">已自动批准</span> : null}
                          </div>
                          {item.message ? <p className="stat-note">{item.message}</p> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {readOnlySuiteJob.approvedIds.length > 0 ? (
                    <div className="flow-actions read-only-suite-run">
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={readOnlySuiteRunBusy}
                        onClick={() => void runApprovedReadOnlySuite()}
                      >
                        {readOnlySuiteRunBusy ? "启动中…" : "运行套件"}
                      </button>
                      {readOnlySuiteBatchMsg ? (
                        <span className="stat-note" role="status">
                          {readOnlySuiteBatchMsg}
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <p className="stat-note">本轮没有可自动批准的用例（未试跑通过或被门禁拦下）</p>
                  )}
                </>
              ) : null}
            </div>
          ) : null}

          {hasFileMediaCapability && fileMediaMechanism && fileMediaMechanism.id === "file-media" ? (
            <div className="card-panel mechanism-card">
              <header className="mechanism-card-header">
                <h3>可测机制</h3>
                <span className="badge subtle">文件/媒体</span>
              </header>
              {fileMediaMechanism.runnable ? (
                <>
                  <p className="stat-note">
                    状态：<strong>可生成草稿</strong> · 从画像生成文件上传用例，仍需人工审阅批准。
                  </p>
                  <div className="mechanism-form-grid">
                  <label className="mechanism-field">
                    场景
                    <select
                      value={mechScenario}
                      onChange={(e) => setMechScenario(e.target.value as FileMediaScenarioKind)}
                    >
                      {fileMediaMechanism.scenarios.map((scenario) => (
                        <option key={scenario.id} value={scenario.kind}>
                          {SCENARIO_LABELS[scenario.kind]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {record.target === "demo" ? (
                    <label className="mechanism-trial">
                      <input
                        type="checkbox"
                        checked={mechTrial}
                        onChange={(e) => setMechTrial(e.target.checked)}
                      />
                      生成后试跑（仅练习环境）
                    </label>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={mechSaving}
                    onClick={() => void createMechanismDraft()}
                  >
                    {mechSaving ? "生成中…" : "生成草稿"}
                  </button>
                  </div>
                  <details className="mechanism-advanced">
                    <summary>定位与引用（高级）</summary>
                    <div className="mechanism-form-grid">
                      {(
                        [
                          ["pagePath", "页面路径"],
                          ["uploadRef", "上传 fixture 引用"],
                          ["fileName", "期望文件名"],
                          ["uploadRequestRef", "上传请求 ref"],
                          ["uploadTarget", "文件输入 testId"],
                          ["submitTarget", "提交按钮 testId"],
                          ["listTarget", "列表 testId"],
                          ["invalidTypeRef", "类型不符 fixture"],
                          ["invalidTypeName", "类型不符文件名"],
                          ["oversizeRef", "超大 fixture"],
                          ["oversizeName", "超大文件名"],
                          ["cleanupPath", "清理请求路径（含 {{uploadedId}}）"],
                          ["cleanupMethod", "清理方法"],
                          ["cleanupIdField", "响应中的 id 字段"],
                        ] as const
                      ).map(([key, label]) => (
                        <label key={key} className="mechanism-field">
                          {label}
                          <input
                            value={mechContext[key]}
                            onChange={(e) =>
                              setMechContext((prev) => ({ ...prev, [key]: e.target.value }))
                            }
                          />
                        </label>
                      ))}
                    </div>
                  </details>
                  {fileMediaMechanism.blockers.length > 0 ? (
                    <ul className="mechanism-blockers stat-note">
                      {fileMediaMechanism.blockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : (
                <>
                  <p className="stat-note">
                    状态：<strong>缺条件</strong>
                  </p>
                  <ul className="mechanism-blockers">
                    {fileMediaMechanism.blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                </>
              )}
              {mechSaved ? (
                <p className="mechanism-success" role="status">
                  草稿已保存：{mechSaved.title}{" "}
                  <button type="button" className="link-button" onClick={() => onOpenReview(mechSaved.testId)}>
                    打开审阅
                  </button>
                </p>
              ) : null}
              {mechError ? <p className="diagnose-msg">{mechError}</p> : null}
            </div>
          ) : null}

          {hasRealtimeCapability &&
          realtimeMechanism &&
          realtimeMechanism.id === "realtime-messaging" ? (
            <div className="card-panel mechanism-card">
              <header className="mechanism-card-header">
                <h3>可测机制</h3>
                <span className="badge subtle">实时消息</span>
              </header>
              {realtimeMechanism.runnable ? (
                <>
                  <p className="stat-note">
                    状态：<strong>可生成草稿</strong> · 双账号 WebSocket 文本送达，仍需人工审阅批准。
                  </p>
                  <div className="mechanism-form-grid">
                    <label className="mechanism-field">
                      场景
                      <select
                        value={realtimeScenario}
                        onChange={(e) =>
                          setRealtimeScenario(e.target.value as RealtimeScenarioKind)
                        }
                      >
                        {realtimeMechanism.scenarios.map((scenario) => (
                          <option key={scenario.id} value={scenario.kind}>
                            {REALTIME_SCENARIO_LABELS[scenario.kind]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="mechanism-field">
                      测试消息
                      <input
                        value={realtimeContext.text}
                        onChange={(e) =>
                          setRealtimeContext((prev) => ({ ...prev, text: e.target.value }))
                        }
                      />
                    </label>
                    {record.target === "demo" ? (
                      <label className="mechanism-trial">
                        <input
                          type="checkbox"
                          checked={realtimeTrial}
                          onChange={(e) => setRealtimeTrial(e.target.checked)}
                        />
                        生成后试跑（仅练习环境）
                      </label>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={realtimeSaving}
                      onClick={() => void createRealtimeDraft()}
                    >
                      {realtimeSaving ? "生成中…" : "生成草稿"}
                    </button>
                  </div>
                  <details className="mechanism-advanced">
                    <summary>定位与 actor（高级）</summary>
                    <div className="mechanism-form-grid">
                      {(
                        [
                          ["pagePath", "页面路径"],
                          ["composerTestId", "输入框 testId"],
                          ["sendTestId", "发送按钮 testId"],
                          ["listTestId", "消息列表 testId"],
                          ["wsUrlIncludes", "WebSocket URL 片段"],
                          ["senderActor", "发送方 actor id"],
                          ["receiverActor", "接收方 actor id"],
                          ["messageCount", "消息条数（去重/严格顺序，2–5）"],
                          ["maxLength", "最大字数（超长场景，10–2000）"],
                          ["overlongText", "超长文本覆盖（可选）"],
                          ["imageTestId", "图片消息 testId"],
                          ["imageButtonTestId", "发送图片按钮 testId"],
                          ["reconnectQuery", "接收方重连查询串"],
                          ["reconnectCountTestId", "重连计数 testId"],
                        ] as const
                      ).map(([key, label]) => (
                        <label key={key} className="mechanism-field">
                          {label}
                          <input
                            value={realtimeContext[key]}
                            onChange={(e) =>
                              setRealtimeContext((prev) => ({ ...prev, [key]: e.target.value }))
                            }
                          />
                        </label>
                      ))}
                    </div>
                  </details>
                  {realtimeMechanism.blockers.length > 0 ? (
                    <ul className="mechanism-blockers stat-note">
                      {realtimeMechanism.blockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : (
                <>
                  <p className="stat-note">
                    状态：<strong>缺条件</strong>
                  </p>
                  <ul className="mechanism-blockers">
                    {realtimeMechanism.blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                </>
              )}
              {realtimeSaved ? (
                <p className="mechanism-success" role="status">
                  草稿已保存：{realtimeSaved.title}{" "}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => onOpenReview(realtimeSaved.testId)}
                  >
                    打开审阅
                  </button>
                </p>
              ) : null}
              {realtimeError ? <p className="diagnose-msg">{realtimeError}</p> : null}
            </div>
          ) : null}

          <div className="card-panel risk-panel">
            <header className="mechanism-card-header">
              <h3>风险与缺口</h3>
              <button
                type="button"
                className="btn-small"
                disabled={riskLoading}
                onClick={() => void generateRiskReport()}
              >
                {riskLoading ? "分析中…" : risk ? "重新分析" : "生成分析"}
              </button>
            </header>
            <p className="stat-note">规则优先，LLM 仅补充建议；不参与批准与门禁。</p>
            {riskError ? <p className="diagnose-msg">{riskError}</p> : null}
            {risk ? (
              <>
                <p className="stat-note">
                  来源：{risk.source === "rules+llm" ? "规则 + LLM" : "规则"}
                  {risk.model ? ` · ${risk.model}` : ""}
                  {risk.tokensUsed ? ` · ${risk.tokensUsed} tokens` : ""} · {risk.risks.length} 条风险
                  {risk.llm?.error ? ` · LLM 失败：${risk.llm.error}` : ""}
                </p>
                {risk.blockers.length > 0 ? (
                  <ul className="risk-blockers">
                    {risk.blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                ) : null}
                {risk.risks.length === 0 ? (
                  <p className="stat-note">当前没有需要提示的风险。</p>
                ) : (
                  <ul className="risk-list">
                    {risk.risks.map((item) => (
                      <li key={item.id} className={`risk-item risk-${item.severity}`}>
                        <div className="risk-item-head">
                          <span className={`badge ${item.severity === "high" ? "weak" : item.severity === "medium" ? "warn" : "subtle"}`}>
                            {RISK_SEVERITY_LABELS[item.severity]}
                          </span>
                          <strong>{item.title}</strong>
                          {item.assumption ? <span className="badge subtle">假设</span> : null}
                        </div>
                        <p className="stat-note">
                          {RISK_CATEGORY_LABELS[item.category]} · 能力 {item.capabilityIds.join(" / ") || "—"} · 证据{" "}
                          {item.evidenceRefs.length}
                        </p>
                        {item.testIdeas.length > 0 ? (
                          <ul className="risk-ideas">
                            {item.testIdeas.map((idea) => (
                              <li key={idea}>{idea}</li>
                            ))}
                          </ul>
                        ) : null}
                        {item.missingInfo.length > 0 ? (
                          <p className="stat-note">待确认：{item.missingInfo.join("；")}</p>
                        ) : null}
                        {onCreateDraftFromRisk ? (
                          <button type="button" className="link-button" onClick={() => onCreateDraftFromRisk(item)}>
                            创建草稿
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="stat-note">尚无风险报告，点击「生成分析」。</p>
            )}
          </div>

          <div className="card-panel explore-panel">
            <header className="mechanism-card-header">
              <h3>主动探索（建议）</h3>
              <button
                type="button"
                className="btn-small"
                disabled={suggestLoading}
                onClick={() => void generateSuggestions()}
              >
                {suggestLoading ? "分析中…" : suggestions ? "刷新建议" : "生成建议"}
              </button>
            </header>
            <p className="stat-note">只作为探索建议：不会自动生成、提交或批准用例。</p>
            {suggestError ? <p className="diagnose-msg">{suggestError}</p> : null}
            {suggestions ? (
              suggestions.length ? (
                <ul className="explore-list">
                  {suggestions.map((item) => (
                    <li key={item.id}>
                      <div className="explore-item-head">
                        <span className="badge subtle">
                          {item.kind === "unvisited-page"
                            ? "未访问页面"
                            : item.kind === "missing-scenario"
                              ? "补充场景"
                              : "未知项"}
                        </span>
                        <strong>{item.title}</strong>
                      </div>
                      <p className="stat-note">
                        {item.why}
                        {item.route ? ` · ${item.route}` : ""}
                      </p>
                      {item.testIdeas.length > 0 ? (
                        <ul className="risk-ideas">
                          {item.testIdeas.map((idea) => (
                            <li key={idea}>{idea}</li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="stat-note">暂无探索建议。</p>
              )
            ) : (
              <p className="stat-note">点击「生成建议」查看未访问页面与覆盖缺口。</p>
            )}
          </div>

          {questionCount > 0 ? (
            <div className="card-panel">
              <h3>待确认</h3>
              <ul className="profile-questions">
                {record.profile.questions.map((question) => (
                  <li key={question.id}>
                    <strong>{CAPABILITY_LABELS[question.capability] ?? question.capability}</strong>：
                    {question.question}
                    {question.routes.length > 0 ? (
                      <span className="stat-note">（{question.routes.join(" · ")}）</span>
                    ) : null}
                  </li>
                ))}
                {llmQuestions.map((question) => (
                  <li key={`llm-${question}`}>
                    <strong>LLM</strong>：{question}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <details className="card-panel profile-surfaces">
            <summary>已采集页面（{record.profile.surfaces.length}）</summary>
            <ul>
              {record.profile.surfaces.map((surface) => (
                <li key={`${surface.route}-${surface.title ?? ""}`}>
                  <code>{surface.route}</code> {surface.title ?? ""}
                  <span className="stat-note"> · {surface.elements.length} 个可见元素</span>
                </li>
              ))}
            </ul>
          </details>


        </>
      ) : !loading ? (
        <div className="card-panel">
          <p className="stat-note">还没有系统画像。选择环境后点击「开始探测」。</p>
        </div>
      ) : null}
          {recent.length > 0 ? (
            <div className="card-panel">
              <h3>最近探测</h3>
              <ul className="profile-recent">
                {recent.map((item) => (
                  <li key={item.id}>
                    <button type="button" className="link-button" onClick={() => setRecord(item)}>
                      {TARGET_LABELS[item.target]} · {new Date(item.createdAt).toLocaleString()} ·{" "}
                      {(item.profile.capabilities.length + (item.profile.llmCapabilities?.length ?? 0))}{" "}
                      项能力
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
    </section>
  );
}

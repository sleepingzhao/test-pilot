import { useEffect, useState } from "react";
import {
  api,
  type DetectionJob,
  type DetectionRecord,
  type DetectionTarget,
  type FileMediaScenarioKind,
  type MechanismPlanResponse,
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
  onRefresh?: () => void;
};

const SCENARIO_LABELS: Record<FileMediaScenarioKind, string> = {
  happy: "正常上传",
  "invalid-type": "类型不符",
  oversize: "超过大小",
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
};

function contextFromPlan(
  ctx: MechanismPlanResponse["mechanisms"][0]["context"] | undefined,
): MechanismContextForm {
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
  onRefresh,
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
  }, [record?.id]);

  useEffect(() => {
    if (!record || loading) {
      setMechanismPlan(null);
      return;
    }
    const hasFileMedia = record.profile.capabilities.some((c) => c.id === "file-media");
    if (!hasFileMedia) {
      setMechanismPlan(null);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams(contextPayload(mechContext));
    api<MechanismPlanResponse>(`/api/detect/${record.id}/mechanisms?${params.toString()}`)
      .then((plan) => {
        if (cancelled) return;
        setMechanismPlan(plan);
        const fileMedia = plan.mechanisms[0];
        if (fileMedia?.scenarios.length && !fileMedia.scenarios.some((s) => s.kind === mechScenario)) {
          setMechScenario(fileMedia.scenarios[0]!.kind);
        }
      })
      .catch(() => {
        if (!cancelled) setMechanismPlan(null);
      });
    return () => {
      cancelled = true;
    };
  }, [record?.id, record?.profile.capabilities, loading, mechContext]);

  useEffect(() => {
    setMechSaved(null);
    setMechError(null);
  }, [record?.id]);

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
  const fileMediaMechanism = mechanismPlan?.mechanisms[0];
  const hasFileMediaCapability = Boolean(
    record?.profile.capabilities.some((c) => c.id === "file-media"),
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

          {hasFileMediaCapability && fileMediaMechanism ? (
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
        </>
      ) : !loading ? (
        <div className="card-panel">
          <p className="stat-note">还没有系统画像。选择环境后点击「开始探测」。</p>
        </div>
      ) : null}
    </section>
  );
}

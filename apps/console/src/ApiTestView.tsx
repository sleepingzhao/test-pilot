import { useState } from "react";
import type { StoredRun, StoredTest } from "./api";
import { api } from "./api";
import { failureKindLabel, summarizeAssertion } from "./stepSummary";

type Props = {
  demoUrl: string;
  demoReachable: boolean | null;
  onRefresh: () => Promise<void>;
  onOpenRun: (runId: string) => void;
  onOpenReview: (testId: string) => void;
};

type Target = "demo" | "custom";

type ApiTestResult = {
  test: StoredTest;
  trial?: { run: StoredRun; trial?: boolean };
  trialError?: string;
  warnings?: string[];
};

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

function parseHeaders(text: string): { headers: Record<string, string>; error?: string } {
  const headers: Record<string, string> = {};
  for (const [index, rawLine] of text.split("\n").entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) {
      return { headers, error: `请求头第 ${index + 1} 行缺少冒号，格式应为 Name: value` };
    }
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { headers };
}

function parseOptionalJson(text: string, label: string): { value?: Record<string, unknown>; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { error: `${label}不是合法 JSON` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: `${label}必须是 JSON 对象` };
  }
  return { value: parsed as Record<string, unknown> };
}

export function ApiTestView({ demoUrl, demoReachable, onRefresh, onOpenRun, onOpenReview }: Props) {
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState<Target>("demo");
  const [customUrl, setCustomUrl] = useState("");
  const [method, setMethod] = useState<(typeof METHODS)[number]>("GET");
  const [path, setPath] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [expectStatus, setExpectStatus] = useState("200");
  const [expectContains, setExpectContains] = useState("");
  const [expectJsonText, setExpectJsonText] = useState("");
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupMethod, setCleanupMethod] = useState<(typeof METHODS)[number]>("DELETE");
  const [cleanupPath, setCleanupPath] = useState("");
  const [cleanupBodyText, setCleanupBodyText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApiTestResult | null>(null);

  const submit = async () => {
    setError(null);
    setResult(null);
    const headerParse = parseHeaders(headersText);
    if (headerParse.error) {
      setError(headerParse.error);
      return;
    }
    const status = Number(expectStatus);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      setError("期望状态码必须是 100-599 的整数");
      return;
    }
    const jsonParse = parseOptionalJson(expectJsonText, "期望响应 JSON ");
    if (jsonParse.error) {
      setError(jsonParse.error);
      return;
    }
    let body: string | Record<string, unknown> | undefined;
    const rawBody = bodyText.trim();
    if (rawBody) {
      if (rawBody.startsWith("{") || rawBody.startsWith("[")) {
        try {
          body = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          setError("请求体看起来是 JSON，但解析失败");
          return;
        }
      } else {
        body = rawBody;
      }
    }
    if (target === "custom" && !customUrl.trim()) {
      setError("自定义环境需要填写 URL");
      return;
    }

    let cleanup: { method?: string; path?: string; body?: string | Record<string, unknown> } | undefined;
    const cleanupPathTrimmed = cleanupPath.trim();
    if (cleanupPathTrimmed) {
      cleanup = { method: cleanupMethod, path: cleanupPathTrimmed };
      const rawCleanupBody = cleanupBodyText.trim();
      if (rawCleanupBody) {
        if (rawCleanupBody.startsWith("{") || rawCleanupBody.startsWith("[")) {
          try {
            cleanup.body = JSON.parse(rawCleanupBody) as Record<string, unknown>;
          } catch {
            setError("清理请求体看起来是 JSON，但解析失败");
            return;
          }
        } else {
          cleanup.body = rawCleanupBody;
        }
      }
    }

    setLoading(true);
    try {
      const res = await api<ApiTestResult>("/api/api-tests", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim() || undefined,
          target,
          customUrl: target === "custom" ? customUrl.trim() : undefined,
          method,
          path: path.trim(),
          headers: Object.keys(headerParse.headers).length ? headerParse.headers : undefined,
          body,
          expectStatus: status,
          expectContains: expectContains.trim() || undefined,
          expectJson: jsonParse.value,
          cleanup,
        }),
      });
      setResult(res);
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const trial = result?.trial?.run;

  return (
    <section className="api-test">
      <div className="card-panel">
        <div className="api-test-lead">
          <div>
            <h3>接口测试</h3>
            <p className="stat-note">
              直接调用与目标环境同源的业务接口，复用登录后的 Cookie。生成的是草稿，批准后才进入回归。
            </p>
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="api-title">用例标题（可选）</label>
            <input
              id="api-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：创建订单成功"
            />
          </div>
          <div className="field field-last">
            <label htmlFor="api-status">期望状态码</label>
            <input
              id="api-status"
              inputMode="numeric"
              value={expectStatus}
              onChange={(e) => setExpectStatus(e.target.value)}
              placeholder="200"
            />
          </div>
        </div>

        <fieldset className="env-picker">
          <legend>目标环境</legend>
          <label>
            <input
              type="radio"
              name="api-env"
              checked={target === "demo"}
              onChange={() => setTarget("demo")}
            />
            练习环境 {demoReachable === false ? "（不可达）" : `(${demoUrl})`}
          </label>
          <label>
            <input
              type="radio"
              name="api-env"
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
              placeholder="https://127.0.0.1:4173"
            />
          ) : null}
        </fieldset>

        <div className="api-request-line">
          <div className="field api-method">
            <label htmlFor="api-method">方法</label>
            <select
              id="api-method"
              value={method}
              onChange={(e) => setMethod(e.target.value as (typeof METHODS)[number])}
            >
              {METHODS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>
          <div className="field api-path">
            <label htmlFor="api-path">路径</label>
            <input
              id="api-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/api/orders"
              spellCheck={false}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="api-headers">请求头（可选，每行 Name: value）</label>
          <textarea
            id="api-headers"
            rows={3}
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
            placeholder={"Authorization: Bearer {{env.apiToken}}\nX-Trace-Id: {{runId}}"}
            spellCheck={false}
          />
        </div>

        <div className="field">
          <label htmlFor="api-body">请求体（可选，JSON 或纯文本）</label>
          <textarea
            id="api-body"
            rows={6}
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            placeholder={'{\n  "name": "测试订单",\n  "ref": "{{runId}}"\n}'}
            spellCheck={false}
          />
        </div>

        <details
          className="api-cleanup-panel"
          open={cleanupOpen}
          onToggle={(e) => setCleanupOpen((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary>清理请求（可选）</summary>
          <p className="hint-inline">
            默认复用上方请求头（含鉴权）。路径可使用 {"{{createdId}}"}（从响应 id 字段保存）或 {"{{runId}}"}。
          </p>
          <div className="api-request-line">
            <div className="field api-method">
              <label htmlFor="api-cleanup-method">方法</label>
              <select
                id="api-cleanup-method"
                value={cleanupMethod}
                onChange={(e) => setCleanupMethod(e.target.value as (typeof METHODS)[number])}
              >
                {METHODS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </div>
            <div className="field api-path">
              <label htmlFor="api-cleanup-path">路径</label>
              <input
                id="api-cleanup-path"
                value={cleanupPath}
                onChange={(e) => setCleanupPath(e.target.value)}
                placeholder="/api/items/{{createdId}}"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="api-cleanup-body">请求体（可选）</label>
            <textarea
              id="api-cleanup-body"
              rows={3}
              value={cleanupBodyText}
              onChange={(e) => setCleanupBodyText(e.target.value)}
              spellCheck={false}
            />
          </div>
        </details>

        <div className="api-assertions">
          <p className="stat-label">断言</p>
          <div className="field">
            <label htmlFor="api-contains">响应包含文本（可选）</label>
            <input
              id="api-contains"
              value={expectContains}
              onChange={(e) => setExpectContains(e.target.value)}
              placeholder="例如：order-created"
            />
          </div>
          <div className="field">
            <label htmlFor="api-json">响应 JSON 应包含（可选）</label>
            <textarea
              id="api-json"
              rows={4}
              value={expectJsonText}
              onChange={(e) => setExpectJsonText(e.target.value)}
              placeholder={'{\n  "ok": true\n}'}
              spellCheck={false}
            />
          </div>
        </div>

        <p className="stat-note">
          支持模板：{"{{runId}}"}、{"{{env.apiToken}}"}（解析到 TESTPILOT_ENV_API_TOKEN）。仅允许同源接口。
        </p>
        <button
          type="button"
          className="btn btn-primary"
          disabled={loading || !path.trim()}
          onClick={() => void submit()}
        >
          {loading ? "执行中…" : "生成草稿并试跑"}
        </button>
        {error ? <p className="diagnose-msg">{error}</p> : null}
      </div>

      {result ? (
        <div className="requirement-result">
          <div className="card-panel">
            <div className="profile-header">
              <div>
                <h3>草稿已保存</h3>
                <p className="run-detail-meta">
                  {result.test.title} · <code>{result.test.id}</code>
                </p>
              </div>
              <span className="badge">草稿 · 未进入回归</span>
            </div>
            <p className="stat-note">审阅步骤和断言后批准，才会参与批量回归。</p>
            {result.warnings && result.warnings.length > 0 ? (
              <ul className="diagnose-list">
                {result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
            <div className="flow-actions">
              <button
                type="button"
                className="btn-small"
                onClick={() => onOpenReview(result.test.id)}
              >
                打开审阅编辑
              </button>
              {trial ? (
                <button type="button" className="btn-small" onClick={() => onOpenRun(trial.runId)}>
                  查看运行详情
                </button>
              ) : null}
            </div>
          </div>

          <div className="card-panel">
            <h3>试跑报告</h3>
            {result.trialError ? (
              <p className="diagnose-msg">试跑未完成：{result.trialError}</p>
            ) : null}
            {trial ? (
              <>
                <p className="run-detail-meta">
                  {trial.status === "passed" ? "通过" : "失败"}
                  {failureKindLabel(trial.metrics?.failureKind)
                    ? ` · ${failureKindLabel(trial.metrics?.failureKind)}`
                    : ""}
                  · {trial.metrics?.durationMs ?? "—"} ms
                </p>
                {trial.cleanup ? (
                  <p className="run-detail-meta">
                    清理：
                    {trial.cleanup.status === "passed"
                      ? "通过"
                      : trial.cleanup.status === "failed"
                        ? "失败"
                        : "未执行"}
                    {trial.cleanup.message ? ` · ${trial.cleanup.message}` : ""}
                  </p>
                ) : null}
                <ol className="run-step-timeline">
                  {trial.steps.map((step) => (
                    <li
                      key={step.stepId}
                      className={`run-step${step.status === "failed" ? " run-step-failed" : ""}`}
                    >
                      <span>{step.stepId}</span>
                      <span>{step.status}</span>
                      {step.message ? <span className="stat-note">{step.message}</span> : null}
                    </li>
                  ))}
                </ol>
                <h4>断言</h4>
                <ul className="diagnose-list">
                  {trial.assertions.map((assertion, index) => (
                    <li key={assertion.assertionId}>
                      {summarizeAssertion(
                        result.test.ir.assertions[index] as Record<string, unknown>,
                        index,
                      )}
                      ：{assertion.passed ? "通过" : assertion.message ?? "失败"}
                    </li>
                  ))}
                </ul>
              </>
            ) : result.trialError ? null : (
              <p className="stat-note">尚未执行试跑。</p>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

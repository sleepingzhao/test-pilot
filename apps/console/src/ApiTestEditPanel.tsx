import { useEffect, useMemo, useState } from "react";
import type { StoredTest } from "./api";

type Props = {
  test: StoredTest;
  onSaved: (updated: StoredTest) => void;
};

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

type RequestStep = {
  id: string;
  action: "request";
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
  [key: string]: unknown;
};

type ApiAssertion = {
  id?: string;
  type?: string;
  stepRef?: string;
  requestRef?: string;
  provider?: string;
  oracle?: string;
  expect?: Record<string, unknown>;
};

function formatBody(body: RequestStep["body"]): string {
  if (body === undefined) return "";
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return body;
      }
    }
    return body;
  }
  return JSON.stringify(body, null, 2);
}

function findRequestStep(steps: unknown[]): { step: RequestStep; index: number } | null {
  const list = steps as Array<{ action?: string }>;
  const index = list.findIndex((s) => s.action === "request");
  if (index < 0) return null;
  return { step: list[index] as RequestStep, index };
}

function headersToText(headers?: Record<string, string>): string {
  if (!headers) return "";
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

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

function parseOptionalJson(
  text: string,
  label: string,
): { value?: Record<string, unknown>; error?: string } {
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

function parseBody(raw: string): { body?: string | Record<string, unknown>; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { body: JSON.parse(trimmed) as Record<string, unknown> };
    } catch {
      return { error: "请求体看起来是 JSON，但解析失败" };
    }
  }
  return { body: trimmed };
}

function formatApiError(text: string, status: number): string {
  try {
    const body = JSON.parse(text) as {
      error?: string;
      message?: string;
      issues?: Array<{ message?: string; path?: string }>;
    };
    if (Array.isArray(body.issues) && body.issues.length > 0) {
      return body.issues.map((i) => i.message ?? i.path ?? "校验失败").join("；");
    }
    return (body.message ?? body.error ?? text) || `HTTP ${status}`;
  } catch {
    return text || `HTTP ${status}`;
  }
}

export function ApiTestEditPanel({ test, onSaved }: Props) {
  const isApi = test.sourceChannel === "api";
  const requestInfo = useMemo(() => findRequestStep(test.ir.steps ?? []), [test.ir.steps]);
  const apiAssertion = useMemo(
    () => test.ir.assertions?.find((x) => (x as ApiAssertion).type === "api") as ApiAssertion | undefined,
    [test.ir.assertions],
  );
  const teardownRequest = useMemo(() => {
    const steps = test.ir.teardownSteps ?? [];
    return steps.find((s) => (s as { action?: string }).action === "request") as RequestStep | undefined;
  }, [test.ir.teardownSteps]);

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    const step = requestInfo?.step;
    const expect = apiAssertion?.expect ?? {};
    const status = expect.statusCode;
    setMethod(
      (METHODS.includes((step?.method ?? "GET").toUpperCase() as (typeof METHODS)[number])
        ? (step?.method ?? "GET").toUpperCase()
        : "GET") as (typeof METHODS)[number],
    );
    setPath(step?.path ?? "");
    setHeadersText(headersToText(step?.headers));
    setBodyText(formatBody(step?.body));
    setExpectStatus(String(typeof status === "number" ? status : 200));
    setExpectContains(String(expect.responseBodyContains ?? ""));
    const jsonBody = expect.responseJsonBody;
    setExpectJsonText(
      jsonBody && typeof jsonBody === "object" && !Array.isArray(jsonBody)
        ? JSON.stringify(jsonBody, null, 2)
        : "",
    );

    const policyCleanup = test.ir.policy?.cleanup;
    const hasTeardown = Boolean(teardownRequest?.path?.trim());
    setCleanupOpen(Boolean(policyCleanup && hasTeardown));
    if (teardownRequest) {
      setCleanupMethod(
        (METHODS.includes((teardownRequest.method ?? "DELETE").toUpperCase() as (typeof METHODS)[number])
          ? (teardownRequest.method ?? "DELETE").toUpperCase()
          : "DELETE") as (typeof METHODS)[number],
      );
      setCleanupPath(teardownRequest.path ?? "");
      setCleanupBodyText(formatBody(teardownRequest.body));
    } else {
      setCleanupMethod("DELETE");
      setCleanupPath("");
      setCleanupBodyText("");
    }
    setError(null);
    setSuccess(null);
  }, [test.id, test.irHash, test.updatedAt, requestInfo, apiAssertion, teardownRequest, test.ir.policy?.cleanup]);

  const save = async () => {
    setError(null);
    setSuccess(null);
    if (!requestInfo) {
      setError("该用例没有 request 步骤，无法编辑接口");
      return;
    }

    const headerParse = parseHeaders(headersText);
    if (headerParse.error) {
      setError(headerParse.error);
      return;
    }

    const bodyParse = parseBody(bodyText);
    if (bodyParse.error) {
      setError(bodyParse.error);
      return;
    }

    const statusNum = Number(expectStatus.trim());
    if (!Number.isInteger(statusNum) || statusNum < 100 || statusNum > 599) {
      setError("期望状态码必须是 100-599 的整数");
      return;
    }

    const jsonParse = parseOptionalJson(expectJsonText, "期望响应 JSON");
    if (jsonParse.error) {
      setError(jsonParse.error);
      return;
    }

    let cleanupBody: string | Record<string, unknown> | undefined;
    if (cleanupOpen && cleanupPath.trim()) {
      const cb = parseBody(cleanupBodyText);
      if (cb.error) {
        setError(cb.error);
        return;
      }
      cleanupBody = cb.body;
    }

    const steps = [...(test.ir.steps ?? [])] as RequestStep[];
    const { index, step: prev } = requestInfo;
    const nextStep: RequestStep = {
      ...prev,
      action: "request",
      method,
      path: path.trim(),
    };
    if (Object.keys(headerParse.headers).length > 0) nextStep.headers = headerParse.headers;
    else delete nextStep.headers;
    if (bodyParse.body !== undefined) nextStep.body = bodyParse.body;
    else delete nextStep.body;
    steps[index] = nextStep;

    const assertions = [...(test.ir.assertions ?? [])] as ApiAssertion[];
    let apiIdx = assertions.findIndex((a) => a.type === "api");
    const prevApi = apiIdx >= 0 ? assertions[apiIdx]! : undefined;
    const expect: Record<string, unknown> = { statusCode: statusNum };
    const contains = expectContains.trim();
    if (contains) expect.responseBodyContains = contains;
    if (jsonParse.value && Object.keys(jsonParse.value).length > 0) {
      expect.responseJsonBody = jsonParse.value;
    }

    const apiPatch: ApiAssertion = {
      ...(prevApi ?? {
        id: "response",
        type: "api",
        provider: "captured-http",
        oracle: "api-contract",
      }),
      type: "api",
      expect,
    };
    if (prevApi?.stepRef) apiPatch.stepRef = prevApi.stepRef;
    else if (prevApi?.requestRef) apiPatch.requestRef = prevApi.requestRef;
    else apiPatch.stepRef = prev.id;

    if (apiIdx >= 0) assertions[apiIdx] = apiPatch;
    else assertions.push(apiPatch);

    const policy: Record<string, unknown> = { ...(test.ir.policy ?? {}) };
    let teardownSteps = [...(test.ir.teardownSteps ?? [])] as RequestStep[];
    const cleanupPathTrim = cleanupOpen ? cleanupPath.trim() : "";
    if (cleanupPathTrim) {
      const cleanupStep: RequestStep = {
        id: "cleanup",
        action: "request",
        method: cleanupMethod,
        path: cleanupPathTrim,
      };
      if (cleanupBody !== undefined) cleanupStep.body = cleanupBody;
      teardownSteps = [cleanupStep];
      policy.cleanup = "always";
    } else {
      teardownSteps = [];
      delete policy.cleanup;
    }

    const newIr: StoredTest["ir"] = {
      ...test.ir,
      id: test.ir.id,
      steps,
      assertions,
    };
    if (teardownSteps.length > 0) newIr.teardownSteps = teardownSteps;
    else delete newIr.teardownSteps;
    if (Object.keys(policy).length > 0) newIr.policy = policy as StoredTest["ir"]["policy"];
    else delete newIr.policy;

    setBusy(true);
    try {
      const res = await fetch(`/api/tests/${test.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ir: newIr }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(formatApiError(text, res.status));
      }
      const updated = (await res.json()) as StoredTest;
      setSuccess("已保存为新草稿版本，需重新审阅批准");
      onSaved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!isApi) return null;

  if (!requestInfo) {
    return (
      <section className="review-section">
        <p className="hint-inline">该 API 用例没有 request 步骤，无法使用接口表单编辑。</p>
      </section>
    );
  }

  return (
    <section className="review-section api-test-edit">
      <div className="review-section-head">
        <h3>接口请求</h3>
        <span className="review-count">API</span>
      </div>
      <p className="hint-inline">修改接口参数后保存为新草稿版本，批准状态会重置，不会自动试跑。</p>

      <div className="field-row">
        <div className="field">
          <label htmlFor="api-edit-method">方法</label>
          <select
            id="api-edit-method"
            value={method}
            onChange={(e) => setMethod(e.target.value as (typeof METHODS)[number])}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="field field-grow">
          <label htmlFor="api-edit-path">路径</label>
          <input
            id="api-edit-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/api/items"
            spellCheck={false}
          />
        </div>
        <div className="field field-last">
          <label htmlFor="api-edit-status">期望状态码</label>
          <input
            id="api-edit-status"
            inputMode="numeric"
            value={expectStatus}
            onChange={(e) => setExpectStatus(e.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="api-edit-headers">请求头（每行 Name: value）</label>
        <textarea
          id="api-edit-headers"
          className="textarea"
          rows={3}
          value={headersText}
          onChange={(e) => setHeadersText(e.target.value)}
          spellCheck={false}
        />
      </div>

      <div className="field">
        <label htmlFor="api-edit-body">请求体</label>
        <textarea
          id="api-edit-body"
          className="textarea"
          rows={4}
          value={bodyText}
          onChange={(e) => setBodyText(e.target.value)}
          placeholder='{"name": "demo-{{runId}}"}'
          spellCheck={false}
        />
      </div>

      <div className="field-row">
        <div className="field field-grow">
          <label htmlFor="api-edit-contains">响应包含（可选）</label>
          <input
            id="api-edit-contains"
            value={expectContains}
            onChange={(e) => setExpectContains(e.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="api-edit-expect-json">期望响应 JSON（可选对象）</label>
        <textarea
          id="api-edit-expect-json"
          className="textarea"
          rows={3}
          value={expectJsonText}
          onChange={(e) => setExpectJsonText(e.target.value)}
          spellCheck={false}
        />
      </div>

      <details className="api-cleanup-edit" open={cleanupOpen}>
        <summary>
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={cleanupOpen}
              onChange={(e) => setCleanupOpen(e.target.checked)}
            />
            配置清理请求（teardown）
          </label>
        </summary>
        {cleanupOpen ? (
          <div className="field-row">
            <div className="field">
              <label htmlFor="api-edit-cleanup-method">清理方法</label>
              <select
                id="api-edit-cleanup-method"
                value={cleanupMethod}
                onChange={(e) => setCleanupMethod(e.target.value as (typeof METHODS)[number])}
              >
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div className="field field-grow">
              <label htmlFor="api-edit-cleanup-path">清理路径</label>
              <input
                id="api-edit-cleanup-path"
                value={cleanupPath}
                onChange={(e) => setCleanupPath(e.target.value)}
                placeholder="/api/items/{{createdId}}"
                spellCheck={false}
              />
            </div>
          </div>
        ) : null}
        {cleanupOpen ? (
          <div className="field">
            <label htmlFor="api-edit-cleanup-body">清理请求体（可选）</label>
            <textarea
              id="api-edit-cleanup-body"
              className="textarea"
              rows={2}
              value={cleanupBodyText}
              onChange={(e) => setCleanupBodyText(e.target.value)}
              spellCheck={false}
            />
          </div>
        ) : null}
      </details>

      {error ? <p className="diagnose-msg">{error}</p> : null}
      {success ? <p className="hint-inline success-note">{success}</p> : null}

      <button type="button" className="btn-small" disabled={busy} onClick={() => void save()}>
        {busy ? "保存中…" : "保存接口修改"}
      </button>
    </section>
  );
}
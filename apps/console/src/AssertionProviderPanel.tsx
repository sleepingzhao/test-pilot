export type AssertionCatalog = {
  providers: Array<{ id: string; kind: string }>;
  dbs: Array<{ ref: string; queryNames: string[]; allowedTables: string[] }>;
  agents: Array<{ ref: string; tracesDir?: string; service?: string }>;
};

export type ProviderDraft = {
  enabled: boolean;
  type: "db" | "agent";
  configRef: string;
  expectJson: string;
  id: string;
  traceRef: string;
};

export type ProviderFeedback = {
  issues?: Array<{ path: string; message: string }>;
  connection?: { ok: boolean; message: string; queryNames?: string[]; sampleTraceFiles?: string[] };
  preview?: unknown;
  previewError?: string;
};

type Props = {
  catalog: AssertionCatalog | null;
  draft: ProviderDraft;
  onDraftChange: (next: ProviderDraft) => void;
  feedback: ProviderFeedback;
  busy: boolean;
  onValidate: () => void;
  onTestConnection: () => void;
  onPreview: () => void;
};

const DB_EXPECT_HINT = `{
  "queryRef": "order-by-run-id",
  "rowCount": 1,
  "row": { "status": "SUBMITTED" }
}`;

const AGENT_EXPECT_HINT = `{
  "traceRef": "demo-run",
  "toolCalls": [{ "name": "search_orders", "minCount": 1 }],
  "forbiddenTools": ["delete_order"]
}`;

export function AssertionProviderPanel({
  catalog,
  draft,
  onDraftChange,
  feedback,
  busy,
  onValidate,
  onTestConnection,
  onPreview,
}: Props) {
  const dbRef = draft.configRef || catalog?.dbs[0]?.ref || "pilot-db";
  const agentRef = draft.configRef || catalog?.agents[0]?.ref || "agent-observability";
  const configRef = draft.type === "db" ? dbRef : agentRef;
  const queryNames =
    catalog?.dbs.find((d) => d.ref === configRef)?.queryNames ?? [];

  return (
    <div className="provider-assertion-box">
      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => onDraftChange({ ...draft, enabled: e.target.checked })}
          />{" "}
          Provider 业务断言（DB / Agent）
        </label>
        <p className="hint-inline">
          选择类型与 Provider，填写 <code>expect</code> JSON；保存前可校验、测试连接、预览样例数据。
        </p>
      </div>
      {draft.enabled && (
        <>
          <div className="field-row">
            <div className="field">
              <label>断言类型</label>
              <select
                value={draft.type}
                onChange={(e) =>
                  onDraftChange({
                    ...draft,
                    type: e.target.value as "db" | "agent",
                    configRef: e.target.value === "db" ? dbRef : agentRef,
                    expectJson: e.target.value === "db" ? DB_EXPECT_HINT : AGENT_EXPECT_HINT,
                  })
                }
              >
                <option value="db">db · postgres-readonly</option>
                <option value="agent">agent · otel-trace</option>
              </select>
            </div>
            <div className="field">
              <label>configRef</label>
              <select
                value={configRef}
                onChange={(e) => onDraftChange({ ...draft, configRef: e.target.value })}
              >
                {(draft.type === "db" ? catalog?.dbs : catalog?.agents)?.map((item) => (
                  <option key={item.ref} value={item.ref}>
                    {item.ref}
                  </option>
                )) ?? <option value={configRef}>{configRef}</option>}
              </select>
            </div>
          </div>
          <div className="field">
            <label>断言 id</label>
            <input
              value={draft.id}
              onChange={(e) => onDraftChange({ ...draft, id: e.target.value })}
              placeholder="order-db-check"
            />
          </div>
          {draft.type === "agent" && (
            <div className="field">
              <label>预览 traceRef（可选）</label>
              <input
                value={draft.traceRef}
                onChange={(e) => onDraftChange({ ...draft, traceRef: e.target.value })}
                placeholder="demo-run 或 {{runId}}"
              />
            </div>
          )}
          {draft.type === "db" && queryNames.length > 0 && (
            <p className="hint-inline">可用 queryRef：{queryNames.join("、")}</p>
          )}
          <div className="field">
            <label>expect（JSON）</label>
            <textarea
              className="textarea"
              rows={6}
              value={draft.expectJson}
              onChange={(e) => onDraftChange({ ...draft, expectJson: e.target.value })}
            />
          </div>
          <div className="provider-actions">
            <button type="button" className="btn btn-tertiary btn-small" disabled={busy} onClick={onValidate}>
              校验
            </button>
            <button
              type="button"
              className="btn btn-tertiary btn-small"
              disabled={busy}
              onClick={onTestConnection}
            >
              测试连接
            </button>
            <button type="button" className="btn btn-tertiary btn-small" disabled={busy} onClick={onPreview}>
              预览
            </button>
          </div>
          {feedback.connection && (
            <p className={`hint-inline ${feedback.connection.ok ? "ok-text" : "warn-text"}`}>
              连接：{feedback.connection.message}
            </p>
          )}
          {feedback.issues && feedback.issues.length > 0 && (
            <ul className="diagnose-list">
              {feedback.issues.map((i) => (
                <li key={`${i.path}:${i.message}`}>
                  {i.path}: {i.message}
                </li>
              ))}
            </ul>
          )}
          {feedback.previewError && <p className="warn-text">{feedback.previewError}</p>}
          {feedback.preview !== undefined && (
            <pre className="preview-json">{JSON.stringify(feedback.preview, null, 2)}</pre>
          )}
        </>
      )}
    </div>
  );
}

export function buildProviderAssertion(draft: ProviderDraft): {
  ok: boolean;
  assertion?: {
    id: string;
    type: "db" | "agent";
    provider: string;
    configRef: string;
    expect: Record<string, unknown>;
    oracle: "human-approved";
  };
  error?: string;
} {
  if (!draft.enabled) return { ok: true };
  let expect: Record<string, unknown>;
  try {
    expect = JSON.parse(draft.expectJson) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "expect JSON 无效" };
  }
  const id = draft.id.trim() || (draft.type === "db" ? "db-business" : "agent-tools");
  const provider = draft.type === "db" ? "postgres-readonly" : "otel-trace";
  return {
    ok: true,
    assertion: {
      id,
      type: draft.type,
      provider,
      configRef: draft.configRef,
      expect,
      oracle: "human-approved",
    },
  };
}

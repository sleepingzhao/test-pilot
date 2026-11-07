import type {
  CapabilityAssessment,
  CapabilityId,
  CapabilityRule,
  DetectionQuestion,
  Signal,
  SignalId,
  SurfaceSnapshot,
} from "./types.js";

/** Below this, a capability is still reported but must be confirmed by a human. */
export const LOW_CONFIDENCE = 0.6;

export const DEFAULT_RULES: CapabilityRule[] = [
  {
    id: "crud.table-actions",
    capability: "crud",
    requiredSignals: ["dom.table", "dom.entity-actions"],
    anySignals: ["dom.form-dialog"],
    confidence: 0.9,
    boostPerExtraSignal: 0.05,
    requires: ["test-data"],
  },
  {
    id: "realtime.websocket-chat",
    capability: "realtime-messaging",
    requiredSignals: ["network.websocket", "dom.message-list", "dom.message-composer"],
    confidence: 0.85,
    requires: ["second-actor", "ws-observable"],
    unknowns: ["消息持久化、重连补发与去重策略需在机制包中确认"],
  },
];

const SIGNAL_LABELS: Record<SignalId, string> = {
  "dom.table": "表格",
  "dom.entity-actions": "实体操作（新增/编辑/删除）",
  "dom.form-dialog": "表单弹窗",
  "dom.login-form": "登录表单",
  "dom.role-menu": "角色/租户菜单",
  "dom.status-column": "状态列",
  "dom.approval-actions": "审批操作",
  "dom.message-list": "消息列表",
  "dom.message-composer": "消息输入区",
  "dom.file-input": "文件上传控件",
  "dom.search-input": "搜索框",
  "dom.pagination": "分页",
  "dom.agent-chat": "Agent 聊天区",
  "dom.streaming-output": "流式输出",
  "dom.tool-call-block": "工具调用块",
  "dom.citation-block": "引用块",
  "dom.contenteditable": "富文本编辑区",
  "network.websocket": "WebSocket 连接",
  "network.sse": "SSE 流",
  "network.upload": "上传接口",
  "network.chat-completion": "Agent/LLM 接口",
  "evidence.second-actor": "第二账号证据",
  "evidence.trace-source": "Trace 源",
};

export function evaluateCapabilities(
  input: { signals: Signal[]; surfaces?: SurfaceSnapshot[] },
  rules: CapabilityRule[] = DEFAULT_RULES,
): { capabilities: CapabilityAssessment[]; questions: DetectionQuestion[] } {
  const bySignal = mergeSignals(input.signals);
  const routes = uniq((input.surfaces ?? []).map((surface) => surface.route)).slice(0, 5);
  const byCapability = new Map<CapabilityId, CapabilityAssessment>();
  const questions: DetectionQuestion[] = [];

  for (const rule of rules) {
    const required = matchedSignals(bySignal, rule.requiredSignals);
    if (required.length === 0) continue;

    if (required.length < rule.requiredSignals.length) {
      const missing = rule.requiredSignals.filter((id) => !bySignal.has(id));
      questions.push({
        id: `${rule.id}:partial`,
        capability: rule.capability,
        question: `发现「${labelsForIds(required.map((signal) => signal.id))}」，但缺少「${labelsForIds(missing)}」；是否仍按 ${rule.capability} 测试？`,
        evidenceIds: evidenceIds(required),
        routes,
      });
      continue;
    }

    const optional = matchedSignals(bySignal, rule.anySignals ?? []);
    const weakest = Math.min(...required.map((signal) => signal.strength));
    const boost = (rule.boostPerExtraSignal ?? 0) * optional.length;
    const confidence = clampConfidence(rule.confidence * weakest + boost);
    const signals = [...required, ...optional];
    const next: CapabilityAssessment = {
      id: rule.capability,
      confidence,
      evidenceIds: evidenceIds(signals),
      signals: uniq(signals.map((signal) => signal.id)),
      requires: uniq(rule.requires ?? []),
      unknowns: uniq(rule.unknowns ?? []),
    };
    const existing = byCapability.get(rule.capability);
    byCapability.set(rule.capability, existing ? mergeAssessments(existing, next) : next);

    if (confidence < LOW_CONFIDENCE) {
      questions.push({
        id: `${rule.id}:low-confidence`,
        capability: rule.capability,
        question: `规则证据较弱（置信度 ${(confidence * 100).toFixed(0)}%）；请确认是否为 ${rule.capability}。`,
        evidenceIds: evidenceIds(signals),
        routes,
      });
    }
  }

  return {
    capabilities: [...byCapability.values()].sort((a, b) => b.confidence - a.confidence),
    questions,
  };
}

function mergeSignals(signals: Signal[]): Map<SignalId, Signal> {
  const map = new Map<SignalId, Signal>();
  for (const signal of signals) {
    const existing = map.get(signal.id);
    if (!existing) {
      map.set(signal.id, { ...signal, evidence: [...signal.evidence] });
      continue;
    }
    map.set(signal.id, {
      ...existing,
      strength: Math.max(existing.strength, signal.strength),
      evidence: [...existing.evidence, ...signal.evidence],
      detail: existing.detail ?? signal.detail,
    });
  }
  return map;
}

function matchedSignals(
  bySignal: Map<SignalId, Signal>,
  ids: SignalId[],
): Signal[] {
  return ids
    .map((id) => bySignal.get(id))
    .filter((signal): signal is Signal => signal !== undefined);
}

function evidenceIds(signals: Signal[]): string[] {
  return uniq(signals.flatMap((signal) => signal.evidence.map((evidence) => evidence.id)));
}

function labelsForIds(ids: SignalId[]): string {
  return ids.map((id) => SIGNAL_LABELS[id]).join("、");
}

function mergeAssessments(
  left: CapabilityAssessment,
  right: CapabilityAssessment,
): CapabilityAssessment {
  return {
    id: left.id,
    confidence: Math.max(left.confidence, right.confidence),
    evidenceIds: uniq([...left.evidenceIds, ...right.evidenceIds]),
    signals: uniq([...left.signals, ...right.signals]),
    requires: uniq([...left.requires, ...right.requires]),
    unknowns: uniq([...left.unknowns, ...right.unknowns]),
  };
}

function clampConfidence(value: number): number {
  return Math.min(0.99, Math.max(0, value));
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

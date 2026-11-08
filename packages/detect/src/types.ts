/** Capability taxonomy v1. Keep this product-agnostic: packs bind to capabilities, not vendors. */
export type CapabilityId =
  | "crud"
  | "auth"
  | "workflow"
  | "realtime-messaging"
  | "file-media"
  | "search-filter"
  | "agent"
  | "rich-content";

/** Prerequisites a capability needs before its mechanism pack can run honestly. */
export type RequirementId =
  | "second-actor"
  | "role-accounts"
  | "ws-observable"
  | "trace-source"
  | "upload-fixture"
  | "test-data"
  | "mutation-allowed";

export type SignalId =
  | "dom.table"
  | "dom.entity-actions"
  | "dom.form-dialog"
  | "dom.login-form"
  | "dom.role-menu"
  | "dom.status-column"
  | "dom.approval-actions"
  | "dom.message-list"
  | "dom.message-composer"
  | "dom.file-input"
  | "dom.search-input"
  | "dom.pagination"
  | "dom.agent-chat"
  | "dom.streaming-output"
  | "dom.tool-call-block"
  | "dom.citation-block"
  | "dom.contenteditable"
  | "network.websocket"
  | "network.sse"
  | "network.upload"
  | "network.chat-completion"
  | "evidence.second-actor"
  | "evidence.trace-source";

export type EvidenceKind =
  | "route"
  | "dom"
  | "network"
  | "websocket"
  | "sse"
  | "screenshot"
  | "trace";

export type EvidenceRef = {
  id: string;
  kind: EvidenceKind;
  summary: string;
  path?: string;
  route?: string;
};

export type Signal = {
  id: SignalId;
  /** 0..1. Weak evidence lowers confidence instead of inventing a capability. */
  strength: number;
  evidence: EvidenceRef[];
  detail?: string;
};

export type SurfaceSnapshot = {
  route: string;
  title?: string;
  elements: Array<{ role?: string; name?: string; testId?: string; inputType?: string }>;
};

export type CapabilityAssessment = {
  id: CapabilityId;
  confidence: number;
  evidenceIds: string[];
  signals: SignalId[];
  requires: RequirementId[];
  unknowns: string[];
};

export type DetectionQuestion = {
  id: string;
  capability: CapabilityId;
  question: string;
  evidenceIds: string[];
  routes: string[];
};

export type DetectionReport = {
  version: 1;
  target: { url: string; mode: "passive" | "probe" | "mutating" };
  surfaces: SurfaceSnapshot[];
  signals: Signal[];
  capabilities: CapabilityAssessment[];
  questions: DetectionQuestion[];
};

/**
 * A deterministic classification rule. Required signals are the evidence; optional
 * signals only raise confidence. Partial matches become questions, never guesses.
 */
export type CapabilityRule = {
  id: string;
  capability: CapabilityId;
  requiredSignals: SignalId[];
  anySignals?: SignalId[];
  /** Only ask a partial-match question when one of these signals is present. */
  partialQuestionSignals?: SignalId[];
  confidence: number;
  boostPerExtraSignal?: number;
  requires?: RequirementId[];
  unknowns?: string[];
};

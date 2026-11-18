import type { SystemProfile } from "@testpilot/detect";

export type DetectionTarget = "demo" | "pilot" | "custom" | "real";

export type PublicApiEnv = {
  id: string;
  label: string;
  baseUrl: string;
  allowWrite: boolean;
  headerNames: string[];
};

export type DetectionRecord = {
  id: string;
  sessionId: string;
  target: DetectionTarget;
  url: string;
  createdAt: string;
  profile: SystemProfile;
};

export type FileMediaScenarioKind = "happy" | "invalid-type" | "oversize";

export type RealtimeScenarioKind = "text";

export type MechanismPlanResponse = {
  detectionId: string;
  target: DetectionTarget;
  mechanisms: Array<
    | {
        id: "file-media";
        runnable: boolean;
        blockers: string[];
        context: {
          pagePath?: string;
          uploadRef: string;
          fileName: string;
          uploadRequestRef: string;
          uploadTarget?: string;
          submitTarget?: string;
          listTarget?: string;
          invalidTypeRef?: string;
          invalidTypeName?: string;
          oversizeRef?: string;
          oversizeName?: string;
          cleanupPath?: string;
          cleanupMethod?: string;
          cleanupIdField?: string;
        };
        scenarios: Array<{ id: string; kind: FileMediaScenarioKind }>;
      }
    | {
        id: "realtime-messaging";
        runnable: boolean;
        blockers: string[];
        context: {
          pagePath?: string;
          composerTestId?: string;
          sendTestId?: string;
          listTestId?: string;
          wsUrlIncludes?: string;
          text?: string;
          senderActor?: string;
          receiverActor?: string;
        };
        scenarios: Array<{ id: string; kind: RealtimeScenarioKind }>;
      }
  >;
};

export type DetectionJob = {
  id: string;
  status: "running" | "completed" | "failed";
  stage: string;
  startedAt: string;
  completedAt?: string;
  result?: DetectionRecord;
  error?: string;
};

export type RecordLocateResponse = {
  locator: { css: string; testId?: string; role?: string; name?: string };
  candidate: {
    index: number;
    tag: string;
    text?: string;
    role?: string;
    name?: string;
    rect: { x: number; y: number; width: number; height: number };
  };
  confidence: number;
  reason: string;
  model: string;
};

export type StoredTest = {
  id: string;
  projectId: string;
  title: string;
  ir: {
    id: string;
    version: number;
    assertions: unknown[];
    steps: unknown[];
    teardownSteps?: unknown[];
    actors?: Array<{ id: string; loginSteps?: unknown[]; baseUrl?: string; baseUrlRef?: string }>;
    policy?: { cleanup?: "none" | "on-success" | "always"; [key: string]: unknown };
    baseUrl?: string;
    baseUrlRef?: string;
  };
  approvalStatus: "draft" | "approved";
  irHash?: string;
  assertionConfigHash?: string;
  currentAssertionConfigHash?: string;
  configHashStale?: boolean;
  approvedAt?: string;
  approvedBy?: string;
  weakAssertions?: Array<{ path: string; message: string }>;
  intentSummary?: string;
  sourceChannel?: "intent" | "prd" | "record" | "api" | "mechanism";
  plannerNotes?: string[];
  updatedAt: string;
};

export type WsFrame = {
  url: string;
  direction: "sent" | "received";
  size: number;
  payload: string;
  at: string;
};

export type WsLog = {
  limit: number;
  dropped: number;
  note?: string;
  frames: WsFrame[];
};

export type ArtifactKind = "trace" | "screenshot" | "har" | "log" | "network" | "ws" | "sse";

export type StoredRun = {
  runId: string;
  testId: string;
  testTitle: string;
  status: string;
  startedAt: string;
  completedAt: string;
  trial?: boolean;
  batchId?: string;
  batchStartedAt?: string;
  metrics?: { durationMs: number; failureKind?: string; attemptCount?: number; flakeRecovery?: boolean };
  /** `multi` when the IR had 2+ actors; omitted on legacy runs. */
  actorMode?: "multi" | "single";
  steps: Array<{
    stepId: string;
    status: string;
    durationMs?: number;
    message?: string;
    screenshot?: string;
    actor?: string;
  }>;
  assertions: Array<{
    assertionId: string;
    passed: boolean;
    message?: string;
    errorKind?: string;
    expected?: unknown;
    actual?: unknown;
  }>;
  artifacts: {
    dir: string;
    artifacts: Array<{ kind: ArtifactKind; path: string }>;
  };
  /** Present files for this run, computed by the API (missing after cleanup). */
  artifactsPresent?: Record<string, boolean>;
  cleanup?: {
    status: "passed" | "failed" | "skipped";
    steps: Array<{ stepId: string; status: string; durationMs?: number; message?: string }>;
    message?: string;
    errorKind?: string;
  };
};

export type StoredBatch = {
  batchId: string;
  startedAt: string;
  completedAt?: string;
  total: number;
  passed: number;
  status: "running" | "completed" | "failed";
  runIds: string[];
  mode?: "full" | "selected" | "include-draft";
  repeatCount?: number;
  error?: string;
  artifactBytesTotal?: number;
};

function approvalHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    const actor = localStorage.getItem("testpilot-approval-actor")?.trim();
    if (actor) headers["x-testpilot-actor"] = actor;
    const token = localStorage.getItem("testpilot-approval-token")?.trim();
    if (token) headers["x-testpilot-approval-token"] = token;
  } catch {
    /* ignore */
  }
  return headers;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  // DELETE has no body; sending application/json with an empty body makes
  // Fastify reject it before the route runs.
  if (init?.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  for (const [key, value] of Object.entries(approvalHeaders())) {
    if (!headers.has(key)) headers.set(key, value);
  }
  const res = await fetch(`${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { error?: string; message?: string };
      throw new Error(body.message ?? body.error ?? text);
    } catch (e) {
      if (e instanceof Error && e.message !== text) throw e;
      throw new Error(text || res.statusText);
    }
  }
  return res.json() as Promise<T>;
}

export type StoredTest = {
  id: string;
  projectId: string;
  title: string;
  ir: { id: string; version: number; assertions: unknown[]; steps: unknown[]; baseUrlRef?: string };
  approvalStatus: "draft" | "approved";
  irHash?: string;
  assertionConfigHash?: string;
  currentAssertionConfigHash?: string;
  configHashStale?: boolean;
  approvedAt?: string;
  approvedBy?: string;
  weakAssertions?: Array<{ path: string; message: string }>;
  intentSummary?: string;
  sourceChannel?: "intent" | "prd" | "record";
  plannerNotes?: string[];
  updatedAt: string;
};

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
  steps: Array<{ stepId: string; status: string; durationMs?: number; message?: string }>;
  assertions: Array<{
    assertionId: string;
    passed: boolean;
    message?: string;
    errorKind?: string;
    expected?: unknown;
    actual?: unknown;
  }>;
  artifacts: { dir: string; artifacts: Array<{ kind: string; path: string }> };
  /** Present files for this run, computed by the API (missing after cleanup). */
  artifactsPresent?: Record<string, boolean>;
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
  const res = await fetch(`${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...approvalHeaders(), ...init?.headers },
  });
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

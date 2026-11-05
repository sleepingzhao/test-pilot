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
  metrics?: { durationMs: number; failureKind?: string; attemptCount?: number; flakeRecovery?: boolean };
  steps: Array<{ stepId: string; status: string; message?: string }>;
  assertions: Array<{ assertionId: string; passed: boolean; message?: string }>;
  artifacts: { dir: string; artifacts: Array<{ kind: string; path: string }> };
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

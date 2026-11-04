export type StoredTest = {
  id: string;
  projectId: string;
  title: string;
  ir: { id: string; version: number; assertions: unknown[]; steps: unknown[]; baseUrlRef?: string };
  approvalStatus: "draft" | "approved";
  irHash?: string;
  approvedAt?: string;
  approvedBy?: string;
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
  metrics?: { durationMs: number; failureKind?: string; attemptCount?: number };
  steps: Array<{ stepId: string; status: string; message?: string }>;
  assertions: Array<{ assertionId: string; passed: boolean; message?: string }>;
  artifacts: { dir: string; artifacts: Array<{ kind: string; path: string }> };
};

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
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

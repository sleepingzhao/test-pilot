export type RetryPolicy = {
  attempts?: number;
  on?: string[];
};

export type RetryDecisionInput = {
  status: "passed" | "failed" | "error";
  failureKind?: string;
  metrics?: { failureKind?: string };
  assertions: Array<{ passed: boolean }>;
};

/** Maps legacy IR tokens to failureKind values used at runtime. */
export function normalizeRetryKind(kind: string): string {
  const k = kind.trim();
  if (k === "transient-network") return "ENVIRONMENT";
  return k;
}

export function shouldRetryAfterFailure(input: RetryDecisionInput, policy?: RetryPolicy): boolean {
  if (input.status === "passed") return false;
  if (input.assertions.some((a) => !a.passed)) return false;

  // Legacy IRs set only `attempts`; keep retrying transient environment failures.
  const configured = policy?.on ?? ["ENVIRONMENT"];
  const allowed = configured.map(normalizeRetryKind).filter(Boolean);
  if (!allowed.length) return false;

  const kind = normalizeRetryKind(input.failureKind ?? input.metrics?.failureKind ?? "UNKNOWN");
  return allowed.includes(kind);
}

export function maxRunAttempts(policy?: RetryPolicy): number {
  const extra = policy?.attempts ?? 0;
  if (extra < 0) return 1;
  return Math.min(extra, 5) + 1;
}

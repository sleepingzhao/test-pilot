import type { StoredRun } from "./api.js";
import { failureKindLabel, failureScreenshotPath } from "./stepSummary.js";

export function artifactFileName(run: StoredRun, kind: string): string | null {
  const entry = run.artifacts?.artifacts?.find((a) => a.kind === kind);
  if (!entry?.path) return null;
  const name = entry.path.split(/[/\\]/).pop();
  return name ?? null;
}

export function artifactUrl(run: StoredRun, fileName: string): string {
  return `/api/runs/${run.runId}/artifacts/${fileName}`;
}

export type EvidenceRow = { label: string; href: string | null };

function available(run: StoredRun, kind: string): boolean {
  const flag = run.artifactsPresent?.[kind];
  if (flag !== undefined) return flag;
  return Boolean(artifactFileName(run, kind));
}

export function listEvidenceRows(run: StoredRun): EvidenceRow[] {
  const trace = artifactFileName(run, "trace");
  const network = artifactFileName(run, "network");
  const rows: EvidenceRow[] = [
    { label: "Trace", href: trace && available(run, "trace") ? artifactUrl(run, trace) : null },
    { label: "Network", href: network && available(run, "network") ? artifactUrl(run, network) : null },
    { label: "截图", href: available(run, "screenshot") ? failureScreenshotPath(run) : null },
  ];
  const har = artifactFileName(run, "har");
  if (har) rows.push({ label: "HAR", href: available(run, "har") ? artifactUrl(run, har) : null });
  const log = artifactFileName(run, "log");
  if (log) rows.push({ label: "运行清单", href: available(run, "log") ? artifactUrl(run, log) : null });
  return rows;
}

export function formatJsonBrief(value: unknown, max = 480): string {
  if (value === undefined) return "—";
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return String(value);
  }
}

export function runDetailHeadline(run: StoredRun): string {
  const kind = failureKindLabel(run.metrics?.failureKind);
  const attempts = run.metrics?.attemptCount ?? 1;
  const parts = [
    run.status === "passed" ? "通过" : run.status === "failed" ? "失败" : run.status,
    `${run.metrics?.durationMs ?? "—"} ms`,
  ];
  if (attempts > 1) parts.push(`${attempts} 次尝试${run.metrics?.flakeRecovery ? "（flake 恢复）" : ""}`);
  if (kind) parts.push(kind);
  return parts.join(" · ");
}

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

export function artifactUrlForFile(run: StoredRun, fileName: string): string {
  if (fileName.includes("/")) return artifactUrlForRelativePath(run, fileName);
  return `/api/runs/${run.runId}/artifacts/${encodeURIComponent(fileName)}`;
}

export function artifactUrlForRelativePath(run: StoredRun, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const encoded = normalized
    .split("/")
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `/api/runs/${run.runId}/artifacts/${encoded}`;
}

const ACTOR_ARTIFACT_KIND_LABEL: Record<string, string> = {
  network: "Network",
  trace: "Trace",
  screenshot: "截图",
  har: "HAR",
  log: "清单",
  ws: "WebSocket",
  sse: "SSE",
};

function artifactPathUnderActors(artifactPath: string): { actorId: string; relative: string } | null {
  const normalized = artifactPath.replace(/\\/g, "/");
  const marker = "/actors/";
  const idx = normalized.indexOf(marker);
  if (idx < 0) return null;
  const rest = normalized.slice(idx + marker.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const actorId = rest.slice(0, slash);
  const file = rest.slice(slash + 1);
  if (!actorId || !file) return null;
  return { actorId, relative: `actors/${actorId}/${file}` };
}

export type ActorEvidenceGroup = {
  actorId: string;
  links: Array<{ label: string; href: string }>;
};

export function listActorEvidenceGroups(run: StoredRun): ActorEvidenceGroup[] {
  const groups = new Map<string, ActorEvidenceGroup["links"]>();
  for (const item of run.artifacts?.artifacts ?? []) {
    const parsed = artifactPathUnderActors(item.path);
    if (!parsed) continue;
    const label = ACTOR_ARTIFACT_KIND_LABEL[item.kind] ?? parsed.relative.split("/").pop() ?? item.kind;
    const href = artifactUrlForRelativePath(run, parsed.relative);
    const bucket = groups.get(parsed.actorId) ?? [];
    bucket.push({ label, href });
    groups.set(parsed.actorId, bucket);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([actorId, links]) => ({ actorId, links }));
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
  const ws = artifactFileName(run, "ws");
  if (ws) rows.push({ label: "WebSocket", href: available(run, "ws") ? artifactUrl(run, ws) : null });
  if (available(run, "sse")) {
    rows.push({ label: "SSE", href: artifactUrlForFile(run, "sse.json") });
  }
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

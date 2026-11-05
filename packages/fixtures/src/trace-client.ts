import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfigBundle } from "./agent-config.js";
import { loadAssertionAgentConfigs } from "./agent-config.js";

export type AgentToolCall = {
  name: string;
  args?: Record<string, unknown>;
  spanId?: string;
};

export type ImportedAgentTrace = {
  traceId: string;
  runId?: string;
  toolCalls: AgentToolCall[];
};

export type TraceClient = {
  getTrace(configRef: string, traceRef: string): Promise<ImportedAgentTrace | undefined>;
};

type OtelAttribute = { key?: string; value?: { stringValue?: string } };

type OtelSpan = {
  traceId?: string;
  spanId?: string;
  name?: string;
  kind?: number;
  attributes?: OtelAttribute[];
};

type OtelResourceSpan = {
  resource?: { attributes?: OtelAttribute[] };
  scopeSpans?: Array<{ spans?: OtelSpan[] }>;
};

export type ParseAgentTraceOptions = {
  /** When set, only resourceSpans whose service.name matches are parsed. */
  service?: string;
  /** Select one trace when an export contains multiple traceIds (usually runId or traceId). */
  traceSelector?: string;
};

function attrString(attrs: OtelAttribute[] | undefined, key: string): string | undefined {
  const hit = attrs?.find((a) => a.key === key);
  return hit?.value?.stringValue;
}

function resourceServiceName(resourceSpans: OtelResourceSpan): string | undefined {
  return attrString(resourceSpans.resource?.attributes, "service.name");
}

function parseOtelSpanToolArgs(attrs: OtelAttribute[] | undefined): Record<string, unknown> | undefined {
  if (!attrs?.length) return undefined;
  const out: Record<string, unknown> = {};
  for (const attr of attrs) {
    if (!attr.key) continue;
    const raw = attr.value?.stringValue;
    if (raw === undefined) continue;
    if (attr.key === "tool.args" || attr.key.endsWith(".tool.args")) {
      try {
        out.toolArgs = JSON.parse(raw) as unknown;
      } catch {
        out.toolArgs = raw;
      }
      continue;
    }
    out[attr.key] = raw;
  }
  const toolArgs = out.toolArgs;
  if (toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs)) {
    return toolArgs as Record<string, unknown>;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Tool span identification (OTLP):
 * - Skip HTTP/server noise: spans with http.method or http.url attributes.
 * - Tool spans: gen_ai.tool.name / tool.name / llm.tool.name attribute, or tool.args attribute.
 * - Tool name: gen_ai.tool.name ?? tool.name ?? span.name when marked as tool.
 */
function isOtelHttpSpan(attrs: OtelAttribute[] | undefined): boolean {
  if (!attrs?.length) return false;
  return attrs.some(
    (a) =>
      a.key === "http.method" ||
      a.key === "http.url" ||
      a.key === "http.target" ||
      a.key === "url.full",
  );
}

function otelSpanToToolCall(span: OtelSpan): AgentToolCall | undefined {
  if (isOtelHttpSpan(span.attributes)) return undefined;
  const toolName =
    attrString(span.attributes, "gen_ai.tool.name") ??
    attrString(span.attributes, "tool.name") ??
    attrString(span.attributes, "llm.tool.name");
  const hasToolArgs = span.attributes?.some((a) => a.key === "tool.args" || a.key?.endsWith(".tool.args"));
  if (!toolName && !hasToolArgs) return undefined;
  const name = toolName ?? span.name?.trim();
  if (!name) return undefined;
  return {
    name,
    spanId: span.spanId,
    args: parseOtelSpanToolArgs(span.attributes),
  };
}

function selectTraceGroup(
  groups: Map<string, { traceId: string; toolCalls: AgentToolCall[]; runId?: string }>,
  traceSelector?: string,
): { traceId: string; toolCalls: AgentToolCall[]; runId?: string } {
  if (groups.size === 0) {
    throw new Error("OTLP export contains no tool spans");
  }
  if (groups.size === 1) {
    return [...groups.values()][0]!;
  }
  if (!traceSelector) {
    throw new Error(
      `OTLP file contains ${groups.size} traces; pass traceRef/traceId to select one (${[...groups.keys()].join(", ")})`,
    );
  }
  const direct = groups.get(traceSelector);
  if (direct) return direct;
  const byRunId = [...groups.values()].filter((g) => g.runId === traceSelector);
  if (byRunId.length === 1) return byRunId[0]!;
  const partial = [...groups.entries()].filter(
    ([traceId, g]) => traceId.includes(traceSelector) || g.runId?.includes(traceSelector),
  );
  if (partial.length === 1) return partial[0]![1];
  throw new Error(
    `cannot select trace for traceRef "${traceSelector}" (${groups.size} traces in file)`,
  );
}

export function parseAgentTraceJson(raw: unknown, options: ParseAgentTraceOptions = {}): ImportedAgentTrace {
  if (!raw || typeof raw !== "object") {
    throw new Error("trace JSON must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.toolCalls)) {
    const toolCalls = (obj.toolCalls as AgentToolCall[]).filter((t) => t?.name);
    return {
      traceId: String(obj.traceId ?? "unknown"),
      runId: obj.runId !== undefined ? String(obj.runId) : undefined,
      toolCalls,
    };
  }

  const resourceSpans = obj.resourceSpans as OtelResourceSpan[] | undefined;
  if (!resourceSpans?.length) {
    throw new Error("trace JSON missing toolCalls or resourceSpans");
  }

  const groups = new Map<string, { traceId: string; toolCalls: AgentToolCall[]; runId?: string }>();

  for (const rs of resourceSpans) {
    if (options.service) {
      const svc = resourceServiceName(rs);
      if (!svc || svc !== options.service) continue;
    }
    for (const scope of rs.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        const tool = otelSpanToToolCall(span);
        if (!tool) continue;
        const traceId = span.traceId ?? "unknown";
        let group = groups.get(traceId);
        if (!group) {
          group = { traceId, toolCalls: [] };
          groups.set(traceId, group);
        }
        group.toolCalls.push(tool);
        const runAttr =
          attrString(span.attributes, "run.id") ??
          attrString(span.attributes, "testpilot.run_id") ??
          attrString(span.attributes, "runId");
        if (runAttr) group.runId = runAttr;
      }
    }
  }

  const picked = selectTraceGroup(groups, options.traceSelector);
  return {
    traceId: picked.traceId,
    runId: picked.runId,
    toolCalls: picked.toolCalls,
  };
}

function sanitizeTraceRef(traceRef: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(traceRef)) {
    throw new Error("invalid traceRef");
  }
  return traceRef;
}

export type TraceClientFactoryOptions = {
  configs?: Record<string, AgentConfigBundle>;
  repoRoot?: string;
  mockGetTrace?: (
    configRef: string,
    traceRef: string,
  ) => Promise<ImportedAgentTrace | undefined>;
};

export function createTraceClient(options: TraceClientFactoryOptions = {}): TraceClient {
  const configs = options.configs ?? loadAssertionAgentConfigs(options.repoRoot);
  const repoRoot =
    options.repoRoot ?? join(dirname(fileURLToPath(import.meta.url)), "../../..");

  return {
    async getTrace(configRef: string, traceRef: string): Promise<ImportedAgentTrace | undefined> {
      if (options.mockGetTrace) {
        return options.mockGetTrace(configRef, traceRef);
      }
      const bundle = configs[configRef];
      if (!bundle?.tracesDir) return undefined;
      const safeRef = sanitizeTraceRef(traceRef);
      const path = join(repoRoot, bundle.tracesDir, `${safeRef}.json`);
      const raw = readFileSync(path, "utf8");
      return parseAgentTraceJson(JSON.parse(raw) as unknown, {
        service: bundle.service,
        traceSelector: safeRef,
      });
    },
  };
}

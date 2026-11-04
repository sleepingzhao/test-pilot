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
  attributes?: OtelAttribute[];
};

function parseOtelSpanAttributes(attrs: OtelAttribute[] | undefined): Record<string, unknown> | undefined {
  if (!attrs?.length) return undefined;
  const out: Record<string, unknown> = {};
  for (const attr of attrs) {
    if (!attr.key) continue;
    const raw = attr.value?.stringValue;
    if (raw === undefined) continue;
    if (attr.key === "tool.args" || attr.key.endsWith(".tool.args")) {
      try {
        out.toolArgs = JSON.parse(raw) as unknown;
        continue;
      } catch {
        out.toolArgs = raw;
        continue;
      }
    }
    out[attr.key] = raw;
  }
  const toolArgs = out.toolArgs;
  if (toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs)) {
    return toolArgs as Record<string, unknown>;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Accept TestPilot canonical JSON or OTLP JSON export (resourceSpans). */
export function parseAgentTraceJson(raw: unknown): ImportedAgentTrace {
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

  const resourceSpans = obj.resourceSpans as
    | Array<{ scopeSpans?: Array<{ spans?: OtelSpan[] }> }>
    | undefined;
  if (!resourceSpans?.length) {
    throw new Error("trace JSON missing toolCalls or resourceSpans");
  }

  const toolCalls: AgentToolCall[] = [];
  let traceId = "unknown";
  for (const rs of resourceSpans) {
    for (const scope of rs.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        if (span.traceId) traceId = span.traceId;
        const name = span.name?.trim();
        if (!name) continue;
        toolCalls.push({
          name,
          spanId: span.spanId,
          args: parseOtelSpanAttributes(span.attributes),
        });
      }
    }
  }
  return { traceId, toolCalls };
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
      return parseAgentTraceJson(JSON.parse(raw) as unknown);
    },
  };
}

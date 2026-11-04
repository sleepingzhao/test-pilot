import {
  listAssertionProviders,
  validateAssertionProviders,
} from "@testpilot/assertions";
import {
  createReadonlyDbClient,
  createTraceClient,
  getAgentConfigBundle,
  loadAssertionAgentConfigs,
  loadAssertionDbConfigs,
  probeDbConnection,
} from "@testpilot/fixtures";
import type { TestAssertion, TestIR } from "@testpilot/test-ir";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function assertionProviderCatalog(): Array<{ id: string; kind: TestAssertion["type"] }> {
  return listAssertionProviders().map((p) => ({ id: p.id, kind: p.kind }));
}

export function assertionConfigCatalog(repoRoot: string): {
  dbs: Array<{ ref: string; queryNames: string[]; allowedTables: string[] }>;
  agents: Array<{ ref: string; tracesDir?: string; service?: string }>;
} {
  const dbs = loadAssertionDbConfigs(repoRoot);
  const agents = loadAssertionAgentConfigs(repoRoot);
  return {
    dbs: Object.entries(dbs).map(([ref, bundle]) => ({
      ref,
      queryNames: Object.keys(bundle.queries),
      allowedTables: bundle.allowedTables,
    })),
    agents: Object.entries(agents).map(([ref, bundle]) => ({
      ref,
      tracesDir: bundle.tracesDir,
      service: bundle.service,
    })),
  };
}

export function validateAssertionsDraft(
  assertions: TestAssertion[],
): Array<{ path: string; message: string }> {
  const ir = {
    id: "draft",
    version: 1,
    platform: "web" as const,
    steps: [{ id: "s", action: "navigate" as const, path: "/" }],
    assertions,
  } satisfies TestIR;
  return validateAssertionProviders(ir);
}

export async function testAssertionConnection(
  kind: "db" | "agent",
  configRef: string,
  repoRoot: string,
): Promise<{
  ok: boolean;
  message: string;
  configured?: boolean;
  queryNames?: string[];
  sampleTraceFiles?: string[];
}> {
  if (kind === "db") {
    const res = await probeDbConnection(configRef, repoRoot);
    return {
      ok: res.ok,
      message: res.ok ? "只读库连接成功" : res.message,
      configured: res.configured,
      queryNames: res.queryNames,
    };
  }

  const bundle = getAgentConfigBundle(configRef, repoRoot);
  if (!bundle) return { ok: false, message: `未知的 Agent 配置: ${configRef}` };
  if (!bundle.tracesDir) {
    return { ok: false, message: "配置缺少 tracesDir" };
  }
  const dir = join(repoRoot, bundle.tracesDir);
  if (!existsSync(dir)) {
    return { ok: false, message: `trace 目录不存在: ${bundle.tracesDir}` };
  }
  const sampleTraceFiles = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .slice(0, 12);
  return {
    ok: true,
    message: `可读 ${sampleTraceFiles.length} 个 trace 样例文件`,
    sampleTraceFiles,
  };
}

export async function previewProviderAssertion(
  assertion: TestAssertion,
  repoRoot: string,
  opts?: { runId?: string; traceRef?: string },
): Promise<{ ok: boolean; message?: string; preview?: unknown }> {
  const runId = opts?.runId ?? "preview_run";
  if (assertion.type === "db" && assertion.provider === "postgres-readonly") {
    const expect = (assertion.expect ?? {}) as { queryRef?: string; params?: Record<string, string> };
    if (!assertion.configRef || !expect.queryRef) {
      return { ok: false, message: "需要 configRef 与 expect.queryRef" };
    }
    const client = createReadonlyDbClient({ configs: loadAssertionDbConfigs(repoRoot) });
    try {
      const params: Record<string, string | number> = { runId };
      if (expect.params) {
        for (const [k, v] of Object.entries(expect.params)) {
          params[k] = String(v).replace(/\{\{runId\}\}/g, runId);
        }
      }
      const result = await client.runNamedQuery(assertion.configRef, expect.queryRef, params);
      return {
        ok: true,
        preview: {
          queryRef: expect.queryRef,
          rowCount: result.rowCount,
          rows: result.rows.slice(0, 5),
        },
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  if (assertion.type === "agent" && assertion.provider === "otel-trace") {
    const expect = (assertion.expect ?? {}) as { traceRef?: string };
    const traceRef =
      (opts?.traceRef ?? expect.traceRef ?? "{{runId}}").replace(/\{\{runId\}\}/g, runId);
    if (!assertion.configRef) {
      return { ok: false, message: "需要 configRef" };
    }
    const traces = createTraceClient({ repoRoot });
    try {
      const trace = await traces.getTrace(assertion.configRef, traceRef);
      if (!trace) return { ok: false, message: `未找到 trace: ${traceRef}` };
      return {
        ok: true,
        preview: {
          traceId: trace.traceId,
          toolCalls: trace.toolCalls.slice(0, 20).map((t) => ({
            name: t.name,
            args: t.args,
          })),
        },
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  return { ok: false, message: "仅支持 postgres-readonly 与 otel-trace 预览" };
}

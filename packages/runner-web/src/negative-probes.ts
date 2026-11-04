import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TestIR } from "@testpilot/test-ir";
import { createReadonlyDbClient, createTraceClient, type RunEnvironment } from "@testpilot/fixtures";
import { runTestIR, type RunResult } from "./run.js";

export type NegativeProbeSpec = {
  id: string;
  provider: string;
  file: string;
};

export type NegativeProbeResult = {
  id: string;
  provider: string;
  file: string;
  /** True when the run failed as expected (probe succeeded). */
  ok: boolean;
  actualStatus: RunResult["status"];
  failedAssertionIds: string[];
  message?: string;
};

export type NegativeProbeReport = {
  completedAt: string;
  ok: boolean;
  probes: NegativeProbeResult[];
};

export function loadProbeCatalog(repoRoot: string): NegativeProbeSpec[] {
  const raw = readFileSync(join(repoRoot, "examples/negative-probes/probe-catalog.json"), "utf8");
  const parsed = JSON.parse(raw) as { probes: NegativeProbeSpec[] };
  return parsed.probes ?? [];
}

function loadProbeIr(repoRoot: string, file: string): TestIR {
  const raw = readFileSync(join(repoRoot, file), "utf8");
  return JSON.parse(raw) as TestIR;
}

function probeAgentMockEnv(baseEnv: RunEnvironment): RunEnvironment {
  const configs = {
    "agent-observability": {
      tracesDir: "examples/agent-traces",
      service: "pilot-agent",
    },
  };
  return {
    ...baseEnv,
    agentTraces: createTraceClient({
      configs,
      mockGetTrace: async () => ({
        traceId: "probe-trace",
        toolCalls: [{ name: "wrong_tool_only", args: {} }],
      }),
    }),
  };
}

function probeDbMockEnv(baseEnv: RunEnvironment): RunEnvironment {
  const configs = {
    "pilot-db": {
      connectionRef: "env.PILOT_DB_URL",
      allowedTables: ["work_order"],
      queries: { "order-by-run-id": "SELECT id FROM work_order WHERE ref = :runId" },
    },
  };
  return {
    ...baseEnv,
    readonlyDb: createReadonlyDbClient({
      configs,
      mockExecute: async () => ({ rowCount: 0, rows: [] }),
    }),
  };
}

export function evaluateNegativeProbeRun(spec: NegativeProbeSpec, run: RunResult): NegativeProbeResult {
  const failedAssertionIds = run.assertions.filter((a) => !a.passed).map((a) => a.assertionId);
  const ok = run.status === "failed" && failedAssertionIds.length > 0;
  return {
    id: spec.id,
    provider: spec.provider,
    file: spec.file,
    ok,
    actualStatus: run.status,
    failedAssertionIds,
    message: ok ? undefined : "expected failed run with failing assertion",
  };
}

export async function runNegativeProbe(
  repoRoot: string,
  spec: NegativeProbeSpec,
  env: RunEnvironment,
  opts?: { headless?: boolean; artifactsDir?: string },
): Promise<{ result: NegativeProbeResult; run: RunResult }> {
  const ir = loadProbeIr(repoRoot, spec.file);
  const runEnv =
    spec.provider === "postgres-readonly"
      ? probeDbMockEnv(env)
      : spec.provider === "otel-trace"
        ? probeAgentMockEnv(env)
        : env;
  const run = await runTestIR(ir, {
    env: runEnv,
    headless: opts?.headless ?? true,
    artifactsDir: opts?.artifactsDir ?? "artifacts",
    runId: `probe_${spec.id}_${Date.now()}`,
  });
  return { result: evaluateNegativeProbeRun(spec, run), run };
}

export async function runNegativeProbeCatalog(
  repoRoot: string,
  env: RunEnvironment,
  opts?: { headless?: boolean; artifactsDir?: string },
): Promise<NegativeProbeReport> {
  const probes = loadProbeCatalog(repoRoot);
  const results: NegativeProbeResult[] = [];
  for (const spec of probes) {
    const { result } = await runNegativeProbe(repoRoot, spec, env, opts);
    results.push(result);
  }
  return {
    completedAt: new Date().toISOString(),
    ok: results.every((r) => r.ok),
    probes: results,
  };
}

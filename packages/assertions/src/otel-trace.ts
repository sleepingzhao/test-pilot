import type { TestAssertion, ValidationIssue } from "@testpilot/test-ir";
import type { AgentConfigBundle, AgentToolCall, ImportedAgentTrace } from "@testpilot/fixtures";
import { partialJsonMatch } from "./api-match.js";
import type { AssertionContext, AssertionOutcome } from "./types.js";

export type ToolCallExpect = {
  name: string;
  minCount?: number;
  maxCount?: number;
  args?: Record<string, unknown>;
};

export type AgentExpect = {
  traceRef?: string;
  toolCalls?: ToolCallExpect[];
  forbiddenTools?: string[];
};

function resolveTraceRef(expect: AgentExpect, runId: string): string {
  const raw = expect.traceRef ?? "{{runId}}";
  return raw.replace(/\{\{runId\}\}/g, runId);
}

function countMatchingCalls(calls: AgentToolCall[], spec: ToolCallExpect): number {
  return calls.filter((c) => {
    if (c.name !== spec.name) return false;
    if (spec.args && !partialJsonMatch(spec.args, c.args ?? {})) return false;
    return true;
  }).length;
}

function redactArgs(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!args) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (/password|secret|token|api[_-]?key/i.test(key)) {
      out[key] = "***";
    } else {
      out[key] = value;
    }
  }
  return out;
}

function traceEvidence(trace: ImportedAgentTrace): Record<string, unknown> {
  return {
    traceId: trace.traceId,
    runId: trace.runId,
    toolCalls: trace.toolCalls.slice(0, 20).map((c) => ({
      name: c.name,
      args: redactArgs(c.args),
    })),
  };
}

export function validateOtelTraceAssertion(
  assertion: TestAssertion,
  resolveAgentConfig?: (configRef: string) => AgentConfigBundle | undefined,
): ValidationIssue[] {
  if (assertion.type !== "agent") return [];
  if (assertion.provider && assertion.provider !== "otel-trace") return [];
  const issues: ValidationIssue[] = [];
  if (!assertion.configRef) {
    issues.push({ path: "configRef", message: "Agent 断言需要 configRef" });
  }
  const expect = (assertion.expect ?? {}) as AgentExpect;
  const hasToolRules = (expect.toolCalls?.length ?? 0) > 0 || (expect.forbiddenTools?.length ?? 0) > 0;
  if (!hasToolRules) {
    issues.push({
      path: "expect",
      message: "Agent 断言需要 expect.toolCalls 和/或 expect.forbiddenTools",
    });
  }
  if (assertion.configRef && resolveAgentConfig) {
    const bundle = resolveAgentConfig(assertion.configRef);
    if (!bundle) {
      issues.push({ path: "configRef", message: `未知的 Agent 配置: ${assertion.configRef}` });
    }
  }
  return issues;
}

export async function runOtelTraceAssertion(
  assertion: TestAssertion,
  ctx: AssertionContext,
): Promise<AssertionOutcome> {
  const id = assertion.id ?? "agent-assertion";
  if (assertion.type !== "agent") {
    return {
      assertionId: id,
      passed: false,
      errorKind: "ASSERTION_ORACLE",
      message: `expected agent assertion, got ${assertion.type}`,
    };
  }

  const configRef = assertion.configRef;
  const expect = (assertion.expect ?? {}) as AgentExpect;
  const runId = ctx.runId ?? "run_unknown";

  if (!configRef) {
    return {
      assertionId: id,
      passed: false,
      errorKind: "ASSERTION_ORACLE",
      message: "agent assertion requires configRef",
    };
  }
  if (!ctx.traces) {
    return {
      assertionId: id,
      passed: false,
      errorKind: "ENVIRONMENT",
      message: "trace client not configured (missing assertion-agent-config)",
    };
  }

  const traceRef = resolveTraceRef(expect, runId);
  let trace: ImportedAgentTrace | undefined;
  try {
    trace = await ctx.traces.getTrace(configRef, traceRef);
  } catch (err) {
    return {
      assertionId: id,
      passed: false,
      errorKind: "ENVIRONMENT",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (!trace) {
    return {
      assertionId: id,
      passed: false,
      errorKind: "ENVIRONMENT",
      message: `no trace found for traceRef ${traceRef}`,
      expected: { traceRef, ...expect },
    };
  }

  const evidence = traceEvidence(trace);

  for (const forbidden of expect.forbiddenTools ?? []) {
    const hit = trace.toolCalls.filter((c) => c.name === forbidden);
    if (hit.length > 0) {
      return {
        assertionId: id,
        passed: false,
        expected: expect,
        actual: evidence,
        errorKind: "PRODUCT_DEFECT",
        message: `forbidden tool invoked: ${forbidden} (${hit.length}x)`,
      };
    }
  }

  for (const spec of expect.toolCalls ?? []) {
    const count = countMatchingCalls(trace.toolCalls, spec);
    const min = spec.minCount ?? 1;
    if (count < min) {
      return {
        assertionId: id,
        passed: false,
        expected: { ...spec, minCount: min },
        actual: { ...evidence, matchedCount: count },
        errorKind: "PRODUCT_DEFECT",
        message: `tool ${spec.name}: expected minCount ${min}, matched ${count}`,
      };
    }
    if (typeof spec.maxCount === "number" && count > spec.maxCount) {
      return {
        assertionId: id,
        passed: false,
        expected: { ...spec, maxCount: spec.maxCount },
        actual: { ...evidence, matchedCount: count },
        errorKind: "PRODUCT_DEFECT",
        message: `tool ${spec.name}: expected maxCount ${spec.maxCount}, matched ${count}`,
      };
    }
  }

  return {
    assertionId: id,
    passed: true,
    expected: expect,
    actual: evidence,
  };
}

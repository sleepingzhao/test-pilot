import assert from "node:assert/strict";
import test from "node:test";
import { createTraceClient, parseAgentTraceJson } from "@testpilot/fixtures";
import { runOtelTraceAssertion, validateOtelTraceAssertion } from "./otel-trace.js";

const configs = {
  "agent-observability": {
    tracesDir: "examples/agent-traces",
    service: "pilot-agent",
  },
};

test("parseAgentTraceJson reads canonical toolCalls", () => {
  const trace = parseAgentTraceJson({
    traceId: "t1",
    toolCalls: [{ name: "search_orders", args: { customerId: "x" } }],
  });
  assert.equal(trace.traceId, "t1");
  assert.equal(trace.toolCalls.length, 1);
  assert.equal(trace.toolCalls[0]?.name, "search_orders");
});

test("parseAgentTraceJson reads OTLP resourceSpans", () => {
  const trace = parseAgentTraceJson({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: "abc",
                spanId: "s1",
                name: "search_orders",
                attributes: [
                  {
                    key: "tool.args",
                    value: { stringValue: "{\"customerId\":\"run-1\"}" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(trace.traceId, "abc");
  assert.deepEqual(trace.toolCalls[0]?.args, { customerId: "run-1" });
});

test("validateOtelTraceAssertion requires config and expect rules", () => {
  const issues = validateOtelTraceAssertion(
    {
      type: "agent",
      provider: "otel-trace",
      configRef: "agent-observability",
      oracle: "human-approved",
      expect: {},
    },
    (ref) => configs[ref as keyof typeof configs],
  );
  assert.ok(issues.some((i) => i.path.includes("expect")));
});

test("runOtelTraceAssertion passes matching tool call", async () => {
  const traces = createTraceClient({
    configs,
    mockGetTrace: async () => ({
      traceId: "tr-1",
      toolCalls: [{ name: "search_orders", args: { customerId: "run_abc" } }],
    }),
  });

  const outcome = await runOtelTraceAssertion(
    {
      id: "a1",
      type: "agent",
      provider: "otel-trace",
      configRef: "agent-observability",
      oracle: "human-approved",
      expect: {
        toolCalls: [{ name: "search_orders", minCount: 1, args: { customerId: "run_abc" } }],
      },
    },
    { page: {} as import("playwright").Page, runId: "run_abc", traces },
  );
  assert.equal(outcome.passed, true);
  assert.equal((outcome.actual as { traceId: string }).traceId, "tr-1");
});

test("runOtelTraceAssertion fails when tool missing (negative)", async () => {
  const traces = createTraceClient({
    configs,
    mockGetTrace: async () => ({
      traceId: "tr-2",
      toolCalls: [{ name: "other_tool", args: {} }],
    }),
  });

  const outcome = await runOtelTraceAssertion(
    {
      id: "a1",
      type: "agent",
      provider: "otel-trace",
      configRef: "agent-observability",
      oracle: "human-approved",
      expect: { toolCalls: [{ name: "search_orders", minCount: 1 }] },
    },
    { page: {} as import("playwright").Page, runId: "run_x", traces },
  );
  assert.equal(outcome.passed, false);
  assert.equal(outcome.errorKind, "PRODUCT_DEFECT");
});

test("runOtelTraceAssertion fails on forbidden tool (negative)", async () => {
  const traces = createTraceClient({
    configs,
    mockGetTrace: async () => ({
      traceId: "tr-3",
      toolCalls: [{ name: "delete_order", args: {} }],
    }),
  });

  const outcome = await runOtelTraceAssertion(
    {
      id: "a1",
      type: "agent",
      provider: "otel-trace",
      configRef: "agent-observability",
      oracle: "human-approved",
      expect: { forbiddenTools: ["delete_order"] },
    },
    { page: {} as import("playwright").Page, runId: "run_x", traces },
  );
  assert.equal(outcome.passed, false);
  assert.match(outcome.message ?? "", /forbidden tool/);
});

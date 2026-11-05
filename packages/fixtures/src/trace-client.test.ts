import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentTraceJson } from "./trace-client.js";

test("parseAgentTraceJson skips resourceSpans without service.name when service filter set", () => {
  const trace = parseAgentTraceJson(
    {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "t-no-svc",
                  spanId: "s1",
                  name: "orphan_tool",
                  attributes: [{ key: "gen_ai.tool.name", value: { stringValue: "orphan_tool" } }],
                },
              ],
            },
          ],
        },
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "pilot-agent" } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "t-ok",
                  spanId: "s2",
                  name: "search_orders",
                  attributes: [{ key: "gen_ai.tool.name", value: { stringValue: "search_orders" } }],
                },
              ],
            },
          ],
        },
      ],
    },
    { service: "pilot-agent" },
  );
  assert.equal(trace.traceId, "t-ok");
  assert.equal(trace.toolCalls.length, 1);
  assert.equal(trace.toolCalls[0]?.name, "search_orders");
});

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertionConfigCatalog,
  assertionProviderCatalog,
  previewProviderAssertion,
  testAssertionConnection,
  validateAssertionsDraft,
} from "./assertion-config.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("assertionProviderCatalog lists built-in providers", () => {
  const ids = assertionProviderCatalog()
    .map((p) => p.id)
    .sort();
  assert.ok(ids.includes("postgres-readonly"));
  assert.ok(ids.includes("otel-trace"));
});

test("assertionConfigCatalog exposes db and agent refs from docs examples", () => {
  const cat = assertionConfigCatalog(repoRoot);
  assert.ok(cat.dbs.some((d) => d.ref === "pilot-db" && d.queryNames.includes("order-by-run-id")));
  assert.ok(cat.agents.some((a) => a.ref === "agent-observability"));
});

test("validateAssertionsDraft rejects agent without tool rules", () => {
  const issues = validateAssertionsDraft([
    {
      id: "a1",
      type: "agent",
      provider: "otel-trace",
      configRef: "agent-observability",
      oracle: "human-approved",
      expect: {},
    },
  ]);
  assert.ok(issues.length > 0);
});

test("testAssertionConnection agent checks traces dir", async () => {
  const res = await testAssertionConnection("agent", "agent-observability", repoRoot);
  assert.equal(res.ok, true);
  assert.ok((res.sampleTraceFiles?.length ?? 0) >= 1);
});

test("previewProviderAssertion loads demo agent trace file", async () => {
  const res = await previewProviderAssertion(
    {
      id: "p1",
      type: "agent",
      provider: "otel-trace",
      configRef: "agent-observability",
      oracle: "human-approved",
      expect: { traceRef: "demo-run" },
    },
    repoRoot,
  );
  assert.equal(res.ok, true);
  const preview = res.preview as { toolCalls?: Array<{ name: string }> };
  assert.ok(preview.toolCalls?.some((t) => t.name === "search_orders"));
});

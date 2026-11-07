import assert from "node:assert/strict";
import test from "node:test";
import { realtimeMessagingPack } from "./realtime-pack.js";

test("realtime pack requires a second actor and observable websocket evidence", () => {
  assert.equal(realtimeMessagingPack.capability, "realtime-messaging");
  assert.ok(realtimeMessagingPack.requires.includes("second-actor"));
  assert.ok(realtimeMessagingPack.requires.includes("ws-observable"));
});

test("realtime pack covers delivery, media, oversize, reconnect, ordering", () => {
  const ids = realtimeMessagingPack.scenarios.map((scenario) => scenario.id);
  for (const expected of [
    "text-delivery",
    "image-delivery",
    "oversize-invariant",
    "reconnect-no-loss",
    "ordering-dedup",
  ]) {
    assert.ok(ids.includes(expected), expected);
  }
});

test("every scenario points at a declared negative probe", () => {
  const probeIds = new Set(realtimeMessagingPack.negativeProbes.map((probe) => probe.id));
  for (const scenario of realtimeMessagingPack.scenarios) {
    assert.ok(probeIds.has(scenario.negativeProbeId), scenario.id);
  }
});

test("every assertion names a provider and a durable evidence channel", () => {
  for (const assertion of realtimeMessagingPack.assertions) {
    assert.ok(assertion.provider.length > 0, assertion.id);
    assert.notEqual(assertion.evidence, "semantic", assertion.id);
  }
});

test("realtime pack defaults to sandbox-only mutations", () => {
  assert.equal(realtimeMessagingPack.safety.mutation, "sandbox-only");
});

// Behavioral acceptance: implement these in V7-4 and V7-3, then remove the todo.
test.todo("A sends a text marker and B receives it: outbound ws frame + inbound ws frame + recipient DOM");
test.todo("blocking B's inbound delivery makes the recipient assertion fail");
test.todo("A sends an image and B renders it: upload API + message type + natural size");
test.todo("oversize message either fails with a stable error or arrives intact, never silently drops");
test.todo("reconnecting B receives missed messages once, in order, without duplicates");

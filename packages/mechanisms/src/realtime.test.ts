import assert from "node:assert/strict";
import test from "node:test";
import { validateAssertionProviders } from "@testpilot/assertions";
import { validateSemantics, validateTestIR } from "@testpilot/test-ir";
import {
  planRealtimeMessaging,
  REALTIME_V7_4B_BLOCKER,
  type RealtimeContext,
  type RealtimeProfile,
} from "./realtime.js";

const ready: RealtimeProfile = {
  capabilities: [
    { id: "crud", confidence: 0.95 },
    { id: "realtime-messaging", confidence: 0.85 },
  ],
};

const baseCtx: RealtimeContext = {};

test("realtime-messaging is not runnable without capability at confidence 0.6", () => {
  const missing = planRealtimeMessaging({ capabilities: [{ id: "crud", confidence: 0.99 }] }, baseCtx);
  assert.equal(missing.mechanism, "realtime-messaging");
  assert.equal(missing.runnable, false);
  assert.equal(missing.scenarios.length, 0);
  assert.match(missing.blockers.join("\n"), /realtime-messaging/);
  assert.match(missing.blockers.join("\n"), /0\.6/);

  const low = planRealtimeMessaging({ capabilities: [{ id: "realtime-messaging", confidence: 0.59 }] }, baseCtx);
  assert.equal(low.runnable, false);
  assert.match(low.blockers.join("\n"), /0\.59/);
});

test("runnable text plan validates IR and uses default actors and expectations", () => {
  const plan = planRealtimeMessaging(ready, baseCtx);
  assert.equal(plan.runnable, true);
  assert.ok(plan.blockers.includes(REALTIME_V7_4B_BLOCKER));
  assert.deepEqual(plan.scenarios.map((s) => s.kind), ["text", "dedupe", "oversize"]);
  const scenario = plan.scenarios[0]!;
  assert.equal(scenario.id, "text");
  assert.deepEqual(scenario.ir.actors?.map((a) => a.id), ["sender", "receiver"]);
  assert.deepEqual(
    scenario.ir.actors?.[0]?.loginSteps?.map((s) => s.id),
    ["sender-open"],
  );
  assert.deepEqual(
    scenario.ir.actors?.[1]?.loginSteps?.map((s) => s.id),
    ["receiver-open"],
  );
  assert.equal(scenario.ir.actors?.[0]?.loginSteps?.[0]?.actor, undefined);
  assert.deepEqual(
    scenario.ir.steps.map((s) => ({ id: s.id, actor: s.actor })),
    [
      { id: "wait-composer", actor: "sender" },
      { id: "fill-text", actor: "sender" },
      { id: "send-message", actor: "sender" },
      { id: "wait-list", actor: "receiver" },
    ],
  );
  assert.equal(scenario.ir.steps[1]?.value, "测试消息");

  const wsSent = scenario.ir.assertions.find((a) => a.id === "ws-sent");
  const wsReceived = scenario.ir.assertions.find((a) => a.id === "ws-received");
  assert.equal(wsSent?.actor, "sender");
  assert.equal(wsReceived?.actor, "receiver");
  assert.deepEqual(wsSent?.expect, {
    direction: "sent",
    contains: "测试消息",
    urlIncludes: "/ws/chat",
    timeoutMs: 5000,
  });
  assert.deepEqual(wsReceived?.expect, {
    direction: "received",
    contains: "测试消息",
    urlIncludes: "/ws/chat",
    timeoutMs: 5000,
  });

  const validated = validateTestIR(scenario.ir);
  assert.equal(validated.ok, true, JSON.stringify(validated.ok ? {} : validated.issues));
  if (validated.ok) assert.deepEqual(validateSemantics(validated.value), []);
  assert.deepEqual(validateAssertionProviders(scenario.ir), []);
});

test("text override applies to steps and assertions", () => {
  const plan = planRealtimeMessaging(ready, { text: "自定义内容" });
  const ir = plan.scenarios[0]!.ir;
  assert.equal(ir.steps.find((s) => s.id === "fill-text")?.value, "自定义内容");
  assert.equal(
    ir.assertions.filter((a) => a.type === "event").every((a) => a.expect?.contains === "自定义内容"),
    true,
  );
  assert.equal(
    ir.assertions.filter((a) => a.type === "ui").every((a) => a.contains === "自定义内容"),
    true,
  );
});

test("unsafe actor ids and sender equals receiver are rejected", () => {
  const badSender = planRealtimeMessaging(ready, { senderActor: "Sender" });
  assert.equal(badSender.runnable, false);
  assert.match(badSender.blockers.join("\n"), /senderActor/);

  const same = planRealtimeMessaging(ready, { senderActor: "alice", receiverActor: "alice" });
  assert.equal(same.runnable, false);
  assert.match(same.blockers.join("\n"), /不能相同/);
});

test("login steps cannot carry actor", () => {
  const plan = planRealtimeMessaging(ready, {
    senderLoginSteps: [{ id: "bad", action: "navigate", path: "/chat", actor: "sender" }],
  });
  assert.equal(plan.runnable, false);
  assert.match(plan.blockers.join("\n"), /不能设置 actor/);
});

test("dedupe scenario validates with maxCount 1 on ws assertions", () => {
  const plan = planRealtimeMessaging(ready, baseCtx);
  const dedupe = plan.scenarios.find((s) => s.kind === "dedupe");
  assert.ok(dedupe);
  assert.equal(dedupe!.ir.id, "realtime-messaging-dedupe");
  assert.equal(dedupe!.ir.steps[0]?.id, "wait-composer");
  assert.deepEqual(
    dedupe!.ir.steps.filter((s) => s.action === "fill").map((s) => s.id),
    ["fill-1", "fill-2", "fill-3"],
  );
  assert.deepEqual(
    dedupe!.ir.steps.filter((s) => s.action === "click").map((s) => s.id),
    ["send-1", "send-2", "send-3"],
  );
  assert.equal(dedupe!.ir.steps.at(-1)?.id, "wait-list");
  assert.equal(dedupe!.ir.assertions.length, 12);
  const wsAssertions = dedupe!.ir.assertions.filter((a) => a.type === "event");
  assert.equal(wsAssertions.length, 6);
  assert.ok(wsAssertions.every((a) => a.expect?.minCount === 1 && a.expect?.maxCount === 1));
  assert.equal(wsAssertions.find((a) => a.id === "ws-received-1")?.expect?.contains, "测试消息-1");

  const validated = validateTestIR(dedupe!.ir);
  assert.equal(validated.ok, true, JSON.stringify(validated.ok ? {} : validated.issues));
  if (validated.ok) assert.deepEqual(validateSemantics(validated.value), []);
  assert.deepEqual(validateAssertionProviders(dedupe!.ir), []);
});

test("dedupe messageCount 2 adjusts steps and assertion counts", () => {
  const plan = planRealtimeMessaging(ready, { messageCount: 2 });
  const dedupe = plan.scenarios.find((s) => s.kind === "dedupe");
  assert.ok(dedupe);
  assert.equal(dedupe!.ir.steps.filter((s) => s.action === "fill").length, 2);
  assert.equal(dedupe!.ir.assertions.length, 8);
  assert.equal(dedupe!.ir.steps.find((s) => s.id === "fill-2")?.value, "测试消息-2");
});

test("invalid messageCount omits dedupe scenario and adds blocker", () => {
  const plan = planRealtimeMessaging(ready, { messageCount: 99 });
  assert.deepEqual(plan.scenarios.map((s) => s.kind), ["text", "oversize"]);
  assert.match(plan.blockers.join("\n"), /messageCount/);
});

test("custom login steps without actor are used as-is", () => {
  const plan = planRealtimeMessaging(ready, {
    senderLoginSteps: [{ id: "sender-custom", action: "navigate", path: "/custom-chat" }],
    receiverLoginSteps: [{ id: "receiver-custom", action: "navigate", path: "/custom-chat" }],
  });
  assert.equal(plan.runnable, true);
  const ir = plan.scenarios[0]!.ir;
  assert.equal(ir.actors?.[0]?.loginSteps?.[0]?.path, "/custom-chat");
  assert.equal(ir.actors?.[1]?.loginSteps?.[0]?.id, "receiver-custom");
});

test("oversize scenario validates with default maxLength and absent ws on receiver", () => {
  const plan = planRealtimeMessaging(ready, baseCtx);
  const oversize = plan.scenarios.find((s) => s.kind === "oversize");
  assert.ok(oversize);
  assert.equal(oversize!.ir.id, "realtime-messaging-oversize");
  const fill = oversize!.ir.steps.find((s) => s.id === "fill-overlong");
  assert.equal(fill?.value?.length, 220);
  const wsError = oversize!.ir.assertions.find((a) => a.id === "ws-sender-error");
  assert.deepEqual(wsError?.expect, {
    contains: "too_long",
    direction: "received",
    urlIncludes: "/ws/chat",
    timeoutMs: 5000,
    minCount: 1,
  });
  const wsAbsent = oversize!.ir.assertions.find((a) => a.id === "ws-receiver-absent");
  assert.equal(wsAbsent?.expect?.absent, true);
  assert.equal(wsAbsent?.expect?.contains, "测".repeat(30));
  assert.equal(oversize!.ir.assertions.filter((a) => a.type === "ui").length, 1);
  const validated = validateTestIR(oversize!.ir);
  assert.equal(validated.ok, true, JSON.stringify(validated.ok ? {} : validated.issues));
  if (validated.ok) assert.deepEqual(validateSemantics(validated.value), []);
  assert.deepEqual(validateAssertionProviders(oversize!.ir), []);
});

test("oversize custom maxLength and overlongText override", () => {
  const custom = "x".repeat(150);
  const plan = planRealtimeMessaging(ready, { maxLength: 100, overlongText: custom });
  const oversize = plan.scenarios.find((s) => s.kind === "oversize");
  assert.ok(oversize);
  assert.equal(oversize!.ir.steps.find((s) => s.id === "fill-overlong")?.value, custom);
  assert.equal(
    oversize!.ir.assertions.find((a) => a.id === "ws-receiver-absent")?.expect?.contains,
    custom.slice(0, 30),
  );
});

test("invalid maxLength omits oversize scenario and adds blocker", () => {
  const plan = planRealtimeMessaging(ready, { maxLength: 3 });
  assert.deepEqual(
    plan.scenarios.map((s) => s.kind),
    ["text", "dedupe"],
  );
  assert.match(plan.blockers.join("\n"), /maxLength/);
});

test("overlongText shorter than maxLength omits oversize scenario", () => {
  const plan = planRealtimeMessaging(ready, { overlongText: "短" });
  assert.ok(!plan.scenarios.some((s) => s.kind === "oversize"));
  assert.match(plan.blockers.join("\n"), /overlongText/);
});
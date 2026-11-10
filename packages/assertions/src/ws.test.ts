import assert from "node:assert/strict";
import test from "node:test";
import type { WsFrame } from "@testpilot/evidence";
import type { TestAssertion } from "@testpilot/test-ir";
import { getAssertionProvider, runAssertion, validateAssertionProviders } from "./index.js";
import type { AssertionContext } from "./types.js";
import { validateWsAssertion } from "./ws.js";

const page = {} as AssertionContext["page"];

function frame(partial: Partial<WsFrame> & Pick<WsFrame, "direction" | "payload">): WsFrame {
  return {
    url: partial.url ?? "ws://127.0.0.1:4173/ws/chat",
    direction: partial.direction,
    size: partial.size ?? partial.payload.length,
    payload: partial.payload,
    at: partial.at ?? "2026-11-10T00:00:00.000Z",
  };
}

function ctx(frames: WsFrame[], waitForWsFrames?: AssertionContext["waitForWsFrames"]): AssertionContext {
  return { page, wsFrames: frames, waitForWsFrames };
}

function assertion(expect: Record<string, unknown>, id = "ws-1"): TestAssertion {
  return { id, type: "event", provider: "ws", expect, oracle: "human-approved" };
}

test("ws provider is registered as an event assertion", () => {
  assert.equal(getAssertionProvider("ws")?.kind, "event");
});

test("matches a frame when contains, direction, and url all hit the same frame", async () => {
  const outcome = await runAssertion(
    assertion({ urlIncludes: "/ws/chat", direction: "received", contains: "hello-ws" }),
    ctx([
      frame({ direction: "sent", payload: "hello-ws" }),
      frame({ direction: "received", url: "ws://127.0.0.1:4173/ws/other", payload: "hello-ws" }),
      frame({ direction: "received", payload: JSON.stringify({ text: "hello-ws" }) }),
    ]),
  );
  assert.equal(outcome.passed, true);
  assert.equal(outcome.actual, 1);
});

test("fails with a redacted frame summary when the text is absent", async () => {
  const secret = "ada.ws@example.com";
  const outcome = await runAssertion(
    assertion({ direction: "received", contains: "hello-ws" }),
    ctx([frame({ direction: "received", payload: JSON.stringify({ email: secret, text: "other-text" }) })]),
  );
  assert.equal(outcome.passed, false);
  assert.equal(outcome.errorKind, "PRODUCT_DEFECT");
  assert.match(outcome.message ?? "", /other-text/);
  assert.match(outcome.message ?? "", /received /);
  assert.equal((outcome.message ?? "").includes(secret), false);
  assert.match(String(outcome.actual), /"email":"\*\*\*"/);
});

test("direction filter does not accept the other direction", async () => {
  const frames = [frame({ direction: "sent", payload: "ping" }), frame({ direction: "received", payload: "pong" })];
  const sent = await runAssertion(assertion({ direction: "sent", contains: "pong" }), ctx(frames));
  assert.equal(sent.passed, false);
  assert.equal(sent.errorKind, "PRODUCT_DEFECT");
  const received = await runAssertion(assertion({ direction: "received", contains: "pong" }), ctx(frames));
  assert.equal(received.passed, true);
});

test("regex must match the payload", async () => {
  const frames = [frame({ direction: "received", payload: "id=42" })];
  const hit = await runAssertion(assertion({ regex: "id=\\d+" }), ctx(frames));
  assert.equal(hit.passed, true);
  const miss = await runAssertion(assertion({ regex: "id=[a-z]+" }), ctx(frames));
  assert.equal(miss.passed, false);
  assert.equal(miss.errorKind, "PRODUCT_DEFECT");
});

test("jsonPath and equals must be satisfied by the same frame as contains", async () => {
  const frames = [
    frame({ direction: "received", payload: JSON.stringify({ message: { text: "hello" } }) }),
    frame({ direction: "received", payload: JSON.stringify({ message: { text: "world" } }) }),
  ];
  const split = await runAssertion(
    assertion({ contains: "hello", jsonPath: "message.text", equals: "world" }),
    ctx(frames),
  );
  assert.equal(split.passed, false);
  assert.equal(split.errorKind, "PRODUCT_DEFECT");
  const same = await runAssertion(
    assertion({ contains: "world", jsonPath: "message.text", equals: "world" }),
    ctx(frames),
  );
  assert.equal(same.passed, true);
  const number = await runAssertion(
    assertion({ jsonPath: "n", equals: 2 }),
    ctx([frame({ direction: "sent", payload: JSON.stringify({ n: 2 }) })]),
  );
  assert.equal(number.passed, true);
});

test("minCount counts frames that satisfy every condition", async () => {
  const frames = [
    frame({ direction: "received", payload: "m-1" }),
    frame({ direction: "received", payload: "m-2" }),
    frame({ direction: "sent", payload: "m-3" }),
  ];
  const enough = await runAssertion(assertion({ direction: "received", contains: "m-", minCount: 2 }), ctx(frames));
  assert.equal(enough.passed, true);
  const short = await runAssertion(assertion({ direction: "received", contains: "m-", minCount: 3 }), ctx(frames));
  assert.equal(short.passed, false);
  assert.equal(short.errorKind, "PRODUCT_DEFECT");
  assert.match(short.message ?? "", /expected at least 3/);
});

test("absent passes only when no frame matches", async () => {
  const frames = [frame({ direction: "sent", payload: "hello" })];
  const clear = await runAssertion(assertion({ direction: "received", contains: "hello", absent: true }), ctx(frames));
  assert.equal(clear.passed, true);
  const present = await runAssertion(assertion({ direction: "sent", contains: "hello", absent: true }), ctx(frames));
  assert.equal(present.passed, false);
  assert.equal(present.errorKind, "PRODUCT_DEFECT");
  assert.match(present.message ?? "", /expected no matching frames/);
});

test("times out as a product defect when a matching frame never arrives", async () => {
  const frames: WsFrame[] = [];
  const outcome = await runAssertion(
    assertion({ direction: "received", contains: "late", timeoutMs: 40 }),
    ctx(frames, async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return false;
    }),
  );
  assert.equal(outcome.passed, false);
  assert.equal(outcome.errorKind, "PRODUCT_DEFECT");
  assert.match(outcome.message ?? "", /after 40ms/);
  assert.match(outcome.message ?? "", /no websocket frames/);
});

test("illegal expect values are assertion oracle errors", async () => {
  const cases: Record<string, unknown>[] = [
    {},
    { timeoutMs: 1000 },
    { direction: "both" },
    { contains: "x", minCount: -1 },
    { contains: "x", minCount: 0 },
    { regex: "(" },
    { jsonPath: 12, equals: "x" },
    { jsonPath: "message.text" },
    { equals: "x" },
    { contains: "x", timeoutMs: 60001 },
  ];
  for (const expect of cases) {
    const outcome = await runAssertion(assertion(expect), ctx([]));
    assert.equal(outcome.passed, false, JSON.stringify(expect));
    assert.equal(outcome.errorKind, "ASSERTION_ORACLE", JSON.stringify(expect));
    const issues = validateWsAssertion(assertion(expect));
    assert.ok(issues.length > 0, JSON.stringify(expect));
  }
  const irIssues = validateAssertionProviders({
    id: "t",
    version: 1,
    platform: "web",
    steps: [{ id: "s", action: "navigate", path: "/chat" }],
    assertions: [assertion({ direction: "sideways" })],
  });
  assert.ok(irIssues.some((issue) => issue.message.includes("sent 或 received")));
});

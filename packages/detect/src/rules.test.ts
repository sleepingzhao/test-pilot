import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCapabilities, LOW_CONFIDENCE } from "./rules.js";
import type { RequirementId, Signal, SignalId } from "./types.js";

function signal(id: SignalId, strength = 1): Signal {
  return {
    id,
    strength,
    evidence: [{ id: `ev-${id}`, kind: "dom", summary: id }],
  };
}

type Case = {
  name: string;
  signals: Signal[];
  expected: "crud" | "realtime-messaging" | null;
  minConfidence?: number;
  maxConfidence?: number;
  requires?: RequirementId[];
  expectQuestion?: boolean;
};

const cases: Case[] = [
  {
    name: "table + entity actions classify CRUD",
    signals: [signal("dom.table"), signal("dom.entity-actions"), signal("dom.form-dialog")],
    expected: "crud",
    minConfidence: 0.9,
    requires: ["test-data"],
  },
  {
    name: "table alone asks for confirmation instead of claiming CRUD",
    signals: [signal("dom.table")],
    expected: null,
    expectQuestion: true,
  },
  {
    name: "websocket + message list + composer classify realtime messaging",
    signals: [
      signal("network.websocket"),
      signal("dom.message-list"),
      signal("dom.message-composer"),
    ],
    expected: "realtime-messaging",
    minConfidence: 0.85,
    requires: ["second-actor", "ws-observable"],
  },
  {
    name: "websocket without a chat surface asks for confirmation",
    signals: [signal("network.websocket")],
    expected: null,
    expectQuestion: true,
  },
  {
    name: "weak realtime signals stay below the confidence gate",
    signals: [
      signal("network.websocket", 0.5),
      signal("dom.message-list", 0.5),
      signal("dom.message-composer", 0.5),
    ],
    expected: "realtime-messaging",
    maxConfidence: LOW_CONFIDENCE - 0.01,
    expectQuestion: true,
  },
  {
    name: "no signals produces no capabilities",
    signals: [],
    expected: null,
    expectQuestion: false,
  },
];

for (const testCase of cases) {
  test(testCase.name, () => {
    const result = evaluateCapabilities({
      signals: testCase.signals,
      surfaces: [{ route: "/inbox", title: "收件箱", elements: [] }],
    });

    if (testCase.expected === null) {
      assert.equal(result.capabilities.length, 0);
    } else {
      const capability = result.capabilities.find((item) => item.id === testCase.expected);
      assert.ok(capability, `expected ${testCase.expected}`);
      if (testCase.minConfidence !== undefined) {
        assert.ok(capability.confidence >= testCase.minConfidence);
      }
      if (testCase.maxConfidence !== undefined) {
        assert.ok(capability.confidence <= testCase.maxConfidence);
      }
      for (const requirement of testCase.requires ?? []) {
        assert.ok(capability.requires.includes(requirement), requirement);
      }
    }

    if (testCase.expectQuestion === true) {
      assert.ok(result.questions.length > 0, "expected a confirmation question");
    }
    if (testCase.expectQuestion === false) {
      assert.equal(result.questions.length, 0);
    }
  });
}

test("duplicate signals merge evidence and keep the strongest strength", () => {
  const result = evaluateCapabilities({
    signals: [
      { id: "dom.table", strength: 0.6, evidence: [{ id: "ev-a", kind: "dom", summary: "a" }] },
      { id: "dom.table", strength: 0.9, evidence: [{ id: "ev-b", kind: "dom", summary: "b" }] },
      signal("dom.entity-actions"),
    ],
  });
  const capability = result.capabilities.find((item) => item.id === "crud");
  assert.ok(capability);
  assert.ok(capability.evidenceIds.includes("ev-a"));
  assert.ok(capability.evidenceIds.includes("ev-b"));
  assert.ok(capability.confidence >= 0.8);
});

test("unconfirmed partial matches carry the page route", () => {
  const result = evaluateCapabilities({
    signals: [signal("dom.table")],
    surfaces: [{ route: "/users", title: "用户管理", elements: [] }],
  });
  assert.equal(result.capabilities.length, 0);
  assert.deepEqual(result.questions[0]?.routes, ["/users"]);
});

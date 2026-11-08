import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCapabilities, LOW_CONFIDENCE } from "./rules.js";
import type { CapabilityId, RequirementId, Signal, SignalId } from "./types.js";

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
  expected: CapabilityId | null;
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
  {
    name: "login form classifies auth",
    signals: [signal("dom.login-form")],
    expected: "auth",
    minConfidence: 0.9,
  },
  {
    name: "role menu classifies auth and needs role accounts",
    signals: [signal("dom.role-menu")],
    expected: "auth",
    minConfidence: 0.7,
    requires: ["role-accounts"],
  },
  {
    name: "status column plus approval actions classify workflow",
    signals: [signal("dom.status-column"), signal("dom.approval-actions")],
    expected: "workflow",
    minConfidence: 0.8,
    requires: ["mutation-allowed", "test-data"],
  },
  {
    name: "file input classifies file media",
    signals: [signal("dom.file-input")],
    expected: "file-media",
    minConfidence: 0.9,
    requires: ["upload-fixture"],
  },
  {
    name: "upload request classifies file media",
    signals: [signal("network.upload")],
    expected: "file-media",
    minConfidence: 0.8,
    requires: ["upload-fixture"],
  },
  {
    name: "search and table classify search filter",
    signals: [signal("dom.search-input"), signal("dom.table")],
    expected: "search-filter",
    minConfidence: 0.8,
    requires: ["test-data"],
  },
  {
    name: "pagination and table classify search filter",
    signals: [signal("dom.pagination"), signal("dom.table")],
    expected: "search-filter",
    minConfidence: 0.75,
  },
  {
    name: "agent chat plus completion request classifies agent",
    signals: [signal("dom.agent-chat"), signal("network.chat-completion")],
    expected: "agent",
    minConfidence: 0.85,
    requires: ["trace-source"],
  },
  {
    name: "agent chat plus tool call block classifies agent",
    signals: [signal("dom.agent-chat"), signal("dom.tool-call-block")],
    expected: "agent",
    minConfidence: 0.85,
    requires: ["trace-source"],
  },
  {
    name: "contenteditable classifies rich content",
    signals: [signal("dom.contenteditable")],
    expected: "rich-content",
    minConfidence: 0.6,
  },
  {
    name: "agent chat alone asks for confirmation",
    signals: [signal("dom.agent-chat")],
    expected: null,
    expectQuestion: true,
  },
  {
    name: "search input without a table asks for confirmation",
    signals: [signal("dom.search-input")],
    expected: null,
    expectQuestion: true,
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

test("rules for the same capability merge evidence", () => {
  const result = evaluateCapabilities({
    signals: [signal("dom.file-input"), signal("network.upload")],
  });
  const capabilities = result.capabilities.filter((item) => item.id === "file-media");
  assert.equal(capabilities.length, 1);
  assert.ok(capabilities[0].confidence >= 0.9);
  assert.ok(capabilities[0].evidenceIds.includes("ev-dom.file-input"));
  assert.ok(capabilities[0].evidenceIds.includes("ev-network.upload"));
  assert.ok(capabilities[0].requires.includes("upload-fixture"));
});

test("a status column alone does not claim workflow", () => {
  const result = evaluateCapabilities({ signals: [signal("dom.status-column")] });
  assert.equal(result.capabilities.some((item) => item.id === "workflow"), false);
  assert.equal(result.questions.length, 0);
});

test("a table alone does not ask search-filter questions", () => {
  const result = evaluateCapabilities({ signals: [signal("dom.table")] });
  assert.equal(
    result.questions.some((question) => question.capability === "search-filter"),
    false,
  );
});

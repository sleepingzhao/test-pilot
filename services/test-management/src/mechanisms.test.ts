import assert from "node:assert/strict";
import test from "node:test";
import type { SystemProfile } from "@testpilot/detect";
import type { DetectionRecord } from "./detection.js";
import { buildFileMediaContext, mechanismPlanForRecord, PILOT_REAL_BLOCKER } from "./mechanisms.js";

const profileBase: SystemProfile = {
  version: 1,
  target: { url: "http://127.0.0.1:4173/", mode: "passive" },
  surfaces: [{ route: "/files", title: "练习", elements: [] }],
  signals: [],
  capabilities: [
    {
      id: "file-media",
      confidence: 0.75,
      evidenceIds: [],
      signals: ["dom.file-input"],
      requires: ["upload-fixture"],
      unknowns: [],
    },
  ],
  questions: [],
};

function recordFor(target: DetectionRecord["target"], profile: SystemProfile): DetectionRecord {
  return {
    id: "detect_mechanism_test",
    sessionId: "session_detect_mechanism_test",
    target,
    url: "http://127.0.0.1:4173/",
    createdAt: "2026-11-12T00:00:00.000Z",
    profile,
  };
}

test("buildFileMediaContext applies defaults", () => {
  const ctx = buildFileMediaContext({});
  assert.equal(ctx.pagePath, "/files");
  assert.equal(ctx.uploadRef, "fixture.samplePng");
  assert.equal(ctx.fileName, "sample.png");
  assert.equal(ctx.uploadRequestRef, "files-upload");
  assert.equal(ctx.uploadTarget?.testId, "file-input");
  assert.equal(ctx.submitTarget?.testId, "file-upload-submit");
  assert.equal(ctx.listTarget?.testId, "file-list");
  assert.equal(ctx.invalidTypeRef, undefined);
  assert.equal(ctx.oversizeRef, undefined);
});

test("empty optional fixture refs are not defaulted", () => {
  const ctx = buildFileMediaContext({
    invalidTypeRef: "",
    oversizeRef: "   ",
    invalidTypeName: "",
  });
  assert.equal(ctx.invalidTypeRef, undefined);
  assert.equal(ctx.oversizeRef, undefined);
  assert.equal(ctx.invalidTypeName, undefined);
});

test("mechanism plan without file-media capability is blocked", () => {
  const record = recordFor("demo", {
    ...profileBase,
    capabilities: [{ id: "crud", confidence: 0.9, evidenceIds: [], signals: [], requires: [], unknowns: [] }],
  });
  const plan = mechanismPlanForRecord(record, "demo");
  assert.equal(plan.mechanisms[0]?.runnable, false);
  assert.equal(plan.mechanisms[0]?.scenarios.length, 0);
});

test("low file-media confidence is blocked", () => {
  const record = recordFor("demo", {
    ...profileBase,
    capabilities: [{ ...profileBase.capabilities[0]!, confidence: 0.5 }],
  });
  const plan = mechanismPlanForRecord(record, "demo");
  assert.equal(plan.mechanisms[0]?.runnable, false);
});

test("real and pilot targets are always blocked for mutating drafts", () => {
  for (const target of ["real", "pilot"] as const) {
    const plan = mechanismPlanForRecord(recordFor(target, profileBase), target);
    assert.equal(plan.mechanisms[0]?.runnable, false);
    assert.ok(plan.mechanisms[0]?.blockers.includes(PILOT_REAL_BLOCKER));
  }
});

test("happy demo plan includes scenario ids and optional negative scenarios", () => {
  const plan = mechanismPlanForRecord(recordFor("demo", profileBase), "demo", {
    invalidTypeRef: "fixture.sampleTxt",
    invalidTypeName: "notes.txt",
    oversizeRef: "fixture.sampleHuge",
    oversizeName: "huge.png",
  });
  assert.equal(plan.mechanisms[0]?.runnable, true);
  assert.deepEqual(
    plan.mechanisms[0]?.scenarios.map((s) => s.id),
    ["happy", "invalid-type", "oversize"],
  );
  const secret = "sk-live-secret-key";
  const raw = JSON.stringify(plan);
  assert.equal(raw.includes(secret), false);
  assert.equal(raw.includes("/Users/"), false);
  assert.equal(raw.includes("TESTPILOT_"), false);
  assert.equal(plan.mechanisms[0]?.context.uploadRef, "fixture.samplePng");
  assert.equal((raw.match(/"ir"/g) ?? []).length, 0);
});

test("invalid or oversize refs add scenarios when provided", () => {
  const onlyInvalid = mechanismPlanForRecord(recordFor("demo", profileBase), "demo", {
    invalidTypeRef: "fixture.sampleTxt",
  });
  assert.deepEqual(
    onlyInvalid.mechanisms[0]?.scenarios.map((s) => s.kind),
    ["happy", "invalid-type"],
  );
});

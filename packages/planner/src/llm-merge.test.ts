import assert from "node:assert/strict";
import test from "node:test";
import { mergeLlmHints } from "./llm-merge.js";
import { filterForbiddenSuggestionTokens } from "./intake.js";

test("mergeLlmHints appends uncertainties and assertions", () => {
  const base = {
    steps: [],
    assertions: [{ id: "a1", type: "ui" as const, contains: "工单", oracle: "human-approved" as const }],
    uncertainties: ["rule"],
    sources: ["intent"],
  };
  const merged = mergeLlmHints(base, {
    uncertainties: ["check form fields"],
    assertionContains: ["提交成功"],
  });
  assert.equal(merged.uncertainties.length, 2);
  assert.equal(merged.assertions.length, 2);
  assert.ok(merged.sources.includes("llm-hints"));
});

test("filterForbiddenSuggestionTokens removes blocked chips", () => {
  const out = filterForbiddenSuggestionTokens(["工单", "上传文件", "提交成功"], ["附件", "上传文件"]);
  assert.deepEqual(out, ["工单", "提交成功"]);
});

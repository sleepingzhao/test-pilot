import assert from "node:assert/strict";
import test from "node:test";
import {
  llmUsageSnapshot,
  recordLlmFailure,
  recordLlmUsage,
  resetLlmUsageForTests,
} from "./llm-usage.js";

test("LLM usage surfaces the last failure and clears it on success", () => {
  resetLlmUsageForTests();
  recordLlmFailure("provider rejected max_tokens");
  assert.equal(llmUsageSnapshot().lastError, "provider rejected max_tokens");

  recordLlmUsage(12);
  assert.deepEqual(llmUsageSnapshot(), { tokensTotal: 12, callCount: 1, lastError: null });
});

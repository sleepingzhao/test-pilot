import assert from "node:assert/strict";
import test from "node:test";
import { llmPlannerConfigFromEnv, llmPlannerPublicInfo } from "./llm-config.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const baseVars = {
  TESTPILOT_LLM_API_KEY: "sk-test",
  TESTPILOT_LLM_PROVIDER: "deepseek",
  TESTPILOT_LLM_BASE_URL: "https://api.deepseek.com/v1",
  TESTPILOT_LLM_MODEL: "deepseek-chat",
  TESTPILOT_LLM_TEMPERATURE: "0.2",
  TESTPILOT_LLM_TIMEOUT_MS: "45000",
};

test("invalid max_tokens disables LLM with a visible error", () => {
  withEnv({ ...baseVars, TESTPILOT_LLM_MAX_TOKENS: "1000000" }, () => {
    assert.equal(llmPlannerConfigFromEnv(), null);
    const info = llmPlannerPublicInfo();
    assert.equal(info.enabled, false);
    assert.match(info.error ?? "", /MAX_TOKENS/);
  });
});

test("valid config enables LLM without an error", () => {
  withEnv({ ...baseVars, TESTPILOT_LLM_MAX_TOKENS: "2048" }, () => {
    const config = llmPlannerConfigFromEnv();
    assert.ok(config);
    assert.equal(config?.maxTokens, 2048);
    const info = llmPlannerPublicInfo();
    assert.equal(info.enabled, true);
    assert.equal(info.error, undefined);
  });
});

test("placeholder key keeps LLM disabled without a config error", () => {
  withEnv({ ...baseVars, TESTPILOT_LLM_API_KEY: "sk-REPLACE_WITH_YOUR_KEY" }, () => {
    assert.equal(llmPlannerConfigFromEnv(), null);
    assert.equal(llmPlannerPublicInfo().error, undefined);
  });
});

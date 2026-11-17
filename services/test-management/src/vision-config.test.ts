import assert from "node:assert/strict";
import test from "node:test";
import { visionConfigFromEnv, visionPublicInfo } from "./vision-config.js";

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

const clearVision = {
  TESTPILOT_VISION_ENABLED: undefined,
  TESTPILOT_VISION_API_KEY: undefined,
  TESTPILOT_VISION_BASE_URL: undefined,
  TESTPILOT_VISION_MODEL: undefined,
  TESTPILOT_VISION_TIMEOUT_MS: undefined,
  TESTPILOT_LLM_API_KEY: undefined,
  TESTPILOT_LLM_BASE_URL: undefined,
};

test("vision disabled by default", () => {
  withEnv(clearVision, () => {
    assert.equal(visionConfigFromEnv(), null);
    assert.equal(visionPublicInfo().enabled, false);
    assert.equal(visionPublicInfo().error, undefined);
  });
});

test("enabled with LLM key fallbacks", () => {
  withEnv(
    {
      ...clearVision,
      TESTPILOT_VISION_ENABLED: "1",
      TESTPILOT_LLM_API_KEY: "sk-vision-fallback",
      TESTPILOT_LLM_BASE_URL: "https://api.deepseek.com/v1",
    },
    () => {
      const config = visionConfigFromEnv();
      assert.ok(config);
      assert.equal(config?.model, "deepseek-flash");
      assert.equal(config?.baseUrl, "https://api.deepseek.com/v1");
      assert.equal(visionPublicInfo().enabled, true);
    },
  );
});

test("custom vision env values", () => {
  withEnv(
    {
      ...clearVision,
      TESTPILOT_VISION_ENABLED: "1",
      TESTPILOT_VISION_API_KEY: "sk-custom",
      TESTPILOT_VISION_BASE_URL: "https://vision.example/v1",
      TESTPILOT_VISION_MODEL: "vision-model",
      TESTPILOT_VISION_TIMEOUT_MS: "120000",
    },
    () => {
      const config = visionConfigFromEnv();
      assert.ok(config);
      assert.equal(config?.model, "vision-model");
      assert.equal(config?.baseUrl, "https://vision.example/v1");
      assert.equal(config?.timeoutMs, 120_000);
    },
  );
});

test("invalid base URL disables config", () => {
  withEnv(
    {
      ...clearVision,
      TESTPILOT_VISION_ENABLED: "1",
      TESTPILOT_VISION_API_KEY: "sk-x",
      TESTPILOT_VISION_BASE_URL: "ftp://bad",
    },
    () => {
      assert.equal(visionConfigFromEnv(), null);
      assert.match(visionPublicInfo().error ?? "", /http/);
    },
  );
});

test("missing key when enabled", () => {
  withEnv(
    {
      ...clearVision,
      TESTPILOT_VISION_ENABLED: "1",
      TESTPILOT_LLM_API_KEY: "sk-REPLACE_WITH_YOUR_KEY",
    },
    () => {
      assert.equal(visionConfigFromEnv(), null);
      assert.match(visionPublicInfo().error ?? "", /API Key/);
    },
  );
});

test("public info never includes api key", () => {
  withEnv(
    {
      ...clearVision,
      TESTPILOT_VISION_ENABLED: "1",
      TESTPILOT_VISION_API_KEY: "sk-secret-vision-key",
    },
    () => {
      const info = visionPublicInfo();
      assert.equal(info.enabled, true);
      assert.equal(JSON.stringify(info).includes("sk-secret"), false);
    },
  );
});
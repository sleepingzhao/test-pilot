const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-flash";

export type VisionRuntimeConfig = {
  enabled: true;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
};

export type VisionPublicInfo = {
  enabled: boolean;
  model: string;
  baseUrl: string;
  error?: string;
};

let configError: string | null = null;

function isUnsetApiKey(key: string): boolean {
  if (!key) return true;
  if (/REPLACE_WITH|YOUR_.*_KEY|changeme/i.test(key)) return true;
  return false;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function isVisionEnabledFlag(): boolean {
  return process.env.TESTPILOT_VISION_ENABLED?.trim() === "1";
}

export function visionConfigFromEnv(): VisionRuntimeConfig | null {
  if (!isVisionEnabledFlag()) {
    configError = null;
    return null;
  }

  const apiKey = (
    process.env.TESTPILOT_VISION_API_KEY?.trim() ||
    process.env.TESTPILOT_LLM_API_KEY?.trim() ||
    ""
  );
  const baseUrl = (
    process.env.TESTPILOT_VISION_BASE_URL?.trim() ||
    process.env.TESTPILOT_LLM_BASE_URL?.trim() ||
    DEFAULT_BASE_URL
  ).replace(/\/$/, "");
  const model = process.env.TESTPILOT_VISION_MODEL?.trim() || DEFAULT_MODEL;
  const timeoutMs = parseIntEnv("TESTPILOT_VISION_TIMEOUT_MS", 60_000);

  if (isUnsetApiKey(apiKey)) {
    configError = "视觉定位已启用但未配置 API Key（TESTPILOT_VISION_API_KEY 或 TESTPILOT_LLM_API_KEY）";
    return null;
  }
  if (!model) {
    configError = "TESTPILOT_VISION_MODEL 不能为空";
    return null;
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 180_000) {
    configError = "TESTPILOT_VISION_TIMEOUT_MS 必须在 10000..180000 之间";
    return null;
  }
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
  } catch {
    configError = "TESTPILOT_VISION_BASE_URL 必须是 http(s) 地址";
    return null;
  }

  configError = null;
  return {
    enabled: true,
    apiKey,
    baseUrl,
    model,
    timeoutMs,
  };
}

export function visionConfigError(): string | null {
  return configError;
}

export function visionPublicInfo(): VisionPublicInfo {
  const config = visionConfigFromEnv();
  const baseUrl = (
    process.env.TESTPILOT_VISION_BASE_URL?.trim() ||
    process.env.TESTPILOT_LLM_BASE_URL?.trim() ||
    DEFAULT_BASE_URL
  ).replace(/\/$/, "");
  const model = process.env.TESTPILOT_VISION_MODEL?.trim() || DEFAULT_MODEL;

  if (!config) {
    return {
      enabled: false,
      model,
      baseUrl,
      ...(isVisionEnabledFlag() && configError ? { error: configError } : {}),
    };
  }
  return {
    enabled: true,
    model: config.model,
    baseUrl: config.baseUrl,
  };
}
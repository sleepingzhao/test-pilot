export type LlmProviderId = "deepseek" | "openai" | "custom";

export type LlmPlannerConfig = {
  provider: LlmProviderId;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
};

export type LlmPlannerPublicInfo = {
  enabled: boolean;
  provider: LlmProviderId;
  model: string;
  baseUrl: string;
  temperature: number;
  maxTokens: number;
};

const PROVIDER_DEFAULTS: Record<Exclude<LlmProviderId, "custom">, { baseUrl: string; model: string }> = {
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
};

function parseProvider(raw: string | undefined): LlmProviderId {
  const v = raw?.trim().toLowerCase();
  if (v === "openai") return "openai";
  if (v === "custom") return "custom";
  return "deepseek";
}

function isUnsetApiKey(key: string): boolean {
  if (!key) return true;
  if (/REPLACE_WITH|YOUR_.*_KEY|changeme/i.test(key)) return true;
  return false;
}

function parseFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function llmPlannerConfigFromEnv(): LlmPlannerConfig | null {
  const apiKey = process.env.TESTPILOT_LLM_API_KEY?.trim() ?? "";
  if (isUnsetApiKey(apiKey)) return null;

  const provider = parseProvider(process.env.TESTPILOT_LLM_PROVIDER);
  const preset = provider === "custom" ? null : PROVIDER_DEFAULTS[provider];
  const baseUrl = (
    process.env.TESTPILOT_LLM_BASE_URL?.trim() ||
    preset?.baseUrl ||
    PROVIDER_DEFAULTS.deepseek.baseUrl
  ).replace(/\/$/, "");
  const model =
    process.env.TESTPILOT_LLM_MODEL?.trim() || preset?.model || PROVIDER_DEFAULTS.deepseek.model;

  return {
    provider,
    apiKey,
    baseUrl,
    model,
    temperature: parseFloatEnv("TESTPILOT_LLM_TEMPERATURE", 0.2),
    maxTokens: parseIntEnv("TESTPILOT_LLM_MAX_TOKENS", 2048),
    timeoutMs: parseIntEnv("TESTPILOT_LLM_TIMEOUT_MS", 45_000),
  };
}

export function llmPlannerPublicInfo(): LlmPlannerPublicInfo {
  const config = llmPlannerConfigFromEnv();
  if (!config) {
    return {
      enabled: false,
      provider: "deepseek",
      model: PROVIDER_DEFAULTS.deepseek.model,
      baseUrl: PROVIDER_DEFAULTS.deepseek.baseUrl,
      temperature: 0.2,
      maxTokens: 2048,
    };
  }
  return {
    enabled: true,
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  };
}

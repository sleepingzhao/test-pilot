/**
 * Optional adapter for a site's login form. Selectors live in
 * TESTPILOT_REAL_LOGIN_PROFILE_JSON; without it the runner uses a generic
 * username/password heuristic. No product-specific selectors belong in code.
 */
export type RealLoginProfile = {
  enterpriseTabText?: string;
  tenantField?: string;
  userField?: string;
  passwordField?: string;
  submitText?: string;
  consentSelector?: string;
};

const STRING_KEYS: Array<keyof RealLoginProfile> = [
  "enterpriseTabText",
  "tenantField",
  "userField",
  "passwordField",
  "submitText",
  "consentSelector",
];

export function realLoginProfileFromEnv(): RealLoginProfile {
  const raw = process.env.TESTPILOT_REAL_LOGIN_PROFILE_JSON?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("TESTPILOT_REAL_LOGIN_PROFILE_JSON 不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("TESTPILOT_REAL_LOGIN_PROFILE_JSON 必须是对象");
  }
  const profile: RealLoginProfile = {};
  for (const key of STRING_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`TESTPILOT_REAL_LOGIN_PROFILE_JSON.${key} 必须是非空字符串`);
    }
    profile[key] = value.trim();
  }
  return profile;
}

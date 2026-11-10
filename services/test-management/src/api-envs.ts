import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type ApiEnvConfig = {
  id: string;
  label: string;
  baseUrl: string;
  headers: Record<string, string>;
  allowWrite: boolean;
};

export type PublicApiEnv = {
  id: string;
  label: string;
  baseUrl: string;
  allowWrite: boolean;
  headerNames: string[];
};

export function apiEnvsFilePath(): string {
  const configured = process.env.TESTPILOT_API_ENVS_FILE?.trim();
  if (configured) {
    return isAbsolute(configured) ? configured : join(repoRoot, configured);
  }
  return join(repoRoot, "api-envs.json");
}

export function isWriteHttpMethod(method: string): boolean {
  return WRITE_METHODS.has(String(method ?? "").trim().toUpperCase());
}

/** Case-insensitive header merge: user-supplied headers override env config (one value per name). */
export function mergeApiEnvHeaders(
  envHeaders: Record<string, string>,
  userHeaders?: Record<string, string>,
): Record<string, string> {
  const lowerToCanonical = new Map<string, string>();
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(envHeaders)) {
    merged[name] = value;
    lowerToCanonical.set(name.toLowerCase(), name);
  }
  for (const [rawName, rawValue] of Object.entries(userHeaders ?? {})) {
    const name = rawName.trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    const existing = lowerToCanonical.get(lower);
    if (existing) {
      delete merged[existing];
      lowerToCanonical.delete(lower);
    }
    merged[name] = String(rawValue ?? "");
    lowerToCanonical.set(lower, name);
  }
  return merged;
}

export function toPublicApiEnv(env: ApiEnvConfig): PublicApiEnv {
  return {
    id: env.id,
    label: env.label,
    baseUrl: env.baseUrl,
    allowWrite: env.allowWrite,
    headerNames: Object.keys(env.headers),
  };
}

export async function loadApiEnvs(): Promise<ApiEnvConfig[]> {
  const path = apiEnvsFilePath();
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const result = parseApiEnvsArray(parsed);
  if (!result.ok) return [];
  return result.envs;
}

export function parseApiEnvsArray(
  raw: unknown[],
): { ok: true; envs: ApiEnvConfig[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const envs: ApiEnvConfig[] = [];
  const ids = new Set<string>();

  raw.forEach((entry, index) => {
    const prefix = `条目 ${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${prefix}: 必须是对象`);
      return;
    }
    const row = entry as Record<string, unknown>;
    const id = String(row.id ?? "").trim();
    if (!ID_PATTERN.test(id)) {
      errors.push(`${prefix}: id 不合法`);
      return;
    }
    if (ids.has(id)) {
      errors.push(`${prefix}: id 重复: ${id}`);
      return;
    }
    ids.add(id);

    const label = String(row.label ?? "").trim();
    if (!label) {
      errors.push(`${prefix}: label 不能为空`);
      return;
    }

    const baseUrl = String(row.baseUrl ?? "").trim();
    const baseUrlIssue = baseUrlIssueMessage(baseUrl);
    if (baseUrlIssue) {
      errors.push(`${prefix}: ${baseUrlIssue}`);
      return;
    }

    let allowWrite = false;
    if (row.allowWrite !== undefined) {
      if (typeof row.allowWrite !== "boolean") {
        errors.push(`${prefix}: allowWrite 必须是布尔值`);
        return;
      }
      allowWrite = row.allowWrite;
    }

    const headersRaw = row.headers;
    if (headersRaw !== undefined && (headersRaw === null || typeof headersRaw !== "object" || Array.isArray(headersRaw))) {
      errors.push(`${prefix}: headers 必须是对象`);
      return;
    }
    const headers: Record<string, string> = {};
    const headerErrors: string[] = [];
    for (const [rawName, rawValue] of Object.entries((headersRaw as Record<string, unknown>) ?? {})) {
      const name = rawName.trim();
      if (!name) {
        headerErrors.push("header 名称不能为空");
        continue;
      }
      if (!HEADER_NAME.test(name)) {
        headerErrors.push(`header 名称不合法: ${name}`);
        continue;
      }
      if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
        headerErrors.push(`不允许配置的 header: ${name}`);
        continue;
      }
      if (typeof rawValue !== "string") {
        headerErrors.push(`header 值必须是字符串: ${name}`);
        continue;
      }
      const valueIssue = headerValueIssueMessage(rawValue);
      if (valueIssue) {
        headerErrors.push(`${name}: ${valueIssue}`);
        continue;
      }
      headers[name] = rawValue;
    }
    if (headerErrors.length) {
      errors.push(`${prefix}: ${headerErrors.join("; ")}`);
      return;
    }

    envs.push({ id, label, baseUrl, headers, allowWrite });
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, envs };
}

function baseUrlIssueMessage(raw: string): string | null {
  if (!raw) return "baseUrl 不能为空";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "baseUrl 不是合法 URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "baseUrl 必须是 http(s)";
  if (url.username || url.password) return "baseUrl 不能包含用户名或密码";
  return null;
}

function headerValueIssueMessage(value: string): string | null {
  if (/[\r\n]/.test(value)) return "值不能包含换行";
  if (value.length > 2_000) return "值过长";
  const token = /\{\{([^{}]*)\}\}/g;
  let match: RegExpExecArray | null;
  let last = 0;
  while ((match = token.exec(value))) {
    const inner = (match[1] ?? "").trim();
    if (!/^env\.[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) {
      return "模板仅允许 {{env.KEY}}";
    }
    last = match.index + match[0].length;
  }
  if (value.slice(last).includes("{{")) return "模板未闭合";
  return null;
}

export async function publicApiEnvs(): Promise<PublicApiEnv[]> {
  return (await loadApiEnvs()).map(toPublicApiEnv);
}

export async function getApiEnvById(id: string): Promise<ApiEnvConfig | undefined> {
  const trimmed = id.trim();
  return (await loadApiEnvs()).find((env) => env.id === trimmed);
}

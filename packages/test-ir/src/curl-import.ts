export type CurlImportRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

export type CurlImportResult =
  | { ok: true; request: CurlImportRequest; warnings: string[] }
  | { ok: false; error: string };

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
]);

const DISPLAY_HEADER_NAMES: Record<string, string> = {
  authorization: "Authorization",
  cookie: "Cookie",
  "proxy-authorization": "Proxy-Authorization",
  "x-api-key": "X-Api-Key",
};

const DATA_FLAGS = new Set([
  "-d",
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-ascii",
  "--data-urlencode",
]);

const IGNORE_NO_ARG = new Set([
  "-s",
  "--silent",
  "-k",
  "--insecure",
  "-L",
  "--location",
  "--compressed",
  "-i",
  "--include",
  "-v",
  "--verbose",
  "--http1.1",
  "--http2",
  "-g",
  "--globoff",
  "--fail",
]);

const IGNORE_WITH_ARG = new Set([
  "-o",
  "--output",
  "--max-time",
  "--connect-timeout",
  "-A",
  "--user-agent",
  "-e",
  "--referer",
  "--interface",
  "--cacert",
  "--cert",
  "--key",
  "--resolve",
  "--proxy",
]);

function preprocessContinuations(raw: string): string {
  return raw.replace(/\\(\r\n|\n|\r)/g, "");
}

function tokenize(raw: string): { ok: true; tokens: string[] } | { ok: false; error: string } {
  const input = preprocessContinuations(raw);
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i]!)) i++;
    if (i >= input.length) break;

    const ch = input[i]!;
    if (ch === "'") {
      i++;
      const start = i;
      while (i < input.length && input[i] !== "'") i++;
      if (i >= input.length) {
        return { ok: false, error: "cURL 里的引号没有闭合" };
      }
      tokens.push(input.slice(start, i));
      i++;
      continue;
    }

    if (ch === '"') {
      i++;
      let value = "";
      let closed = false;
      while (i < input.length) {
        const c = input[i]!;
        if (c === "\\" && i + 1 < input.length) {
          const next = input[i + 1]!;
          if (next === '"' || next === "\\" || next === "$" || next === "`") {
            value += next;
            i += 2;
            continue;
          }
          value += c;
          i++;
          continue;
        }
        if (c === '"') {
          i++;
          closed = true;
          break;
        }
        value += c;
        i++;
      }
      if (!closed) {
        return { ok: false, error: "cURL 里的引号没有闭合" };
      }
      tokens.push(value);
      continue;
    }

    const start = i;
    while (i < input.length && !/\s/.test(input[i]!)) i++;
    tokens.push(input.slice(start, i));
  }
  return { ok: true, tokens };
}

function normalizeUrlCandidate(raw: string): string {
  let url = raw.trim();
  if (url.endsWith("\\")) {
    url = url.slice(0, -1).trimEnd();
  }
  return url;
}

function isAbsoluteHttpUrl(url: string): { ok: true; href: string } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "URL 不是绝对地址" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "只支持 http(s) URL" };
  }
  return { ok: true, href: url };
}

function parseHeaderLine(line: string): { name: string; value: string } | null {
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  const name = line.slice(0, colon).trim();
  const value = line.slice(colon + 1).trim();
  if (!name) return null;
  return { name, value };
}

function setHeader(
  headers: Map<string, { name: string; value: string }>,
  name: string,
  value: string,
): string | null {
  if (/[\r\n]/.test(value)) {
    return "请求头包含换行";
  }
  const key = name.toLowerCase();
  headers.set(key, { name, value });
  return null;
}

function consumeValue(tokens: string[], index: number): { value?: string; next: number } {
  if (index >= tokens.length) return { next: index };
  const tok = tokens[index]!;
  if (tok.startsWith("-")) return { next: index };
  return { value: tok, next: index + 1 };
}

export function parseCurlCommand(raw: string): CurlImportResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "请粘贴 cURL 命令" };
  }

  const tokenized = tokenize(trimmed);
  if (!tokenized.ok) return tokenized;

  const tokens = tokenized.tokens;
  let i = 0;
  while (i < tokens.length && tokens[i]!.includes("=")) {
    i++;
  }
  if (i >= tokens.length) {
    return { ok: false, error: "看起来不是 cURL 命令" };
  }
  const lead = tokens[i]!.toLowerCase();
  if (lead !== "curl" && lead !== "curl.exe") {
    return { ok: false, error: "看起来不是 cURL 命令" };
  }
  i++;

  const urlCandidates: string[] = [];
  let method: string | undefined;
  const dataParts: string[] = [];
  const headerMap = new Map<string, { name: string; value: string }>();
  const droppedAuthHeaders: string[] = [];
  const warnings: string[] = [];
  let sawUserAuth = false;
  let sawOAuthBearer = false;

  const dropSensitiveHeader = (canonicalKey: string) => {
    if (!droppedAuthHeaders.includes(canonicalKey)) {
      droppedAuthHeaders.push(canonicalKey);
    }
    headerMap.delete(canonicalKey);
  };

  while (i < tokens.length) {
    const tok = tokens[i]!;

    if (!tok.startsWith("-")) {
      urlCandidates.push(normalizeUrlCandidate(tok));
      i++;
      continue;
    }

    if (tok === "--url") {
      i++;
      const { value, next } = consumeValue(tokens, i);
      i = next;
      if (value) urlCandidates.push(normalizeUrlCandidate(value));
      continue;
    }

    if (tok === "-X" || tok === "--request") {
      i++;
      const { value, next } = consumeValue(tokens, i);
      i = next;
      if (value) method = value.toUpperCase();
      continue;
    }

    if (DATA_FLAGS.has(tok)) {
      i++;
      const { value, next } = consumeValue(tokens, i);
      i = next;
      if (value !== undefined) dataParts.push(value);
      continue;
    }

    if (tok === "-H" || tok === "--header") {
      i++;
      const { value, next } = consumeValue(tokens, i);
      i = next;
      if (!value) continue;
      const parsed = parseHeaderLine(value);
      if (!parsed) continue;
      const key = parsed.name.toLowerCase();
      if (SENSITIVE_HEADERS.has(key)) {
        dropSensitiveHeader(key);
        continue;
      }
      const headerErr = setHeader(headerMap, parsed.name, parsed.value);
      if (headerErr) return { ok: false, error: headerErr };
      continue;
    }

    if (tok === "-u" || tok === "--user") {
      i++;
      const { next } = consumeValue(tokens, i);
      i = next;
      sawUserAuth = true;
      continue;
    }

    if (tok === "--oauth2-bearer") {
      i++;
      const { next } = consumeValue(tokens, i);
      i = next;
      sawOAuthBearer = true;
      continue;
    }

    if (IGNORE_NO_ARG.has(tok)) {
      i++;
      continue;
    }

    if (IGNORE_WITH_ARG.has(tok)) {
      i++;
      const { next } = consumeValue(tokens, i);
      i = next;
      continue;
    }

    i++;
    if (i < tokens.length && !tokens[i]!.startsWith("-")) {
      i++;
    }
  }

  if (droppedAuthHeaders.length > 0) {
    const names = droppedAuthHeaders
      .map((key) => DISPLAY_HEADER_NAMES[key] ?? key)
      .join("、");
    warnings.push(`已忽略鉴权头：${names}（请在 API 环境里配置，或手动填写 {{env.KEY}}）`);
  }
  if (sawUserAuth) {
    warnings.push("已忽略 -u 账号密码（请改用 API 环境配置）");
  }
  if (sawOAuthBearer) {
    warnings.push("已忽略 --oauth2-bearer（请改用 API 环境配置）");
  }

  if (urlCandidates.length === 0) {
    return { ok: false, error: "没有找到 URL" };
  }

  const urlRaw = urlCandidates[urlCandidates.length - 1]!;
  const urlCheck = isAbsoluteHttpUrl(urlRaw);
  if (!urlCheck.ok) {
    return { ok: false, error: urlCheck.error };
  }

  const resolvedMethod = method ?? (dataParts.length > 0 ? "POST" : "GET");
  const body = dataParts.length > 0 ? dataParts.join("&") : undefined;

  const headers: Record<string, string> = {};
  for (const { name, value } of headerMap.values()) {
    headers[name] = value;
  }

  return {
    ok: true,
    request: {
      url: urlCheck.href,
      method: resolvedMethod,
      headers,
      body,
    },
    warnings,
  };
}

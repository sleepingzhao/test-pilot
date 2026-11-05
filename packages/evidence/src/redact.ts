const SENSITIVE_HEADER = /^(set-cookie|cookie|authorization|proxy-authorization)$/i;
const SENSITIVE_KEY = /password|token|secret|api[_-]?key|phone|mobile|email|address|idcard/i;
const SENSITIVE_QUERY = /^(token|phone|email|mobile|password|secret|api[_-]?key)$/i;

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(key)) u.searchParams.set(key, "***");
    }
    return u.toString().slice(0, 500);
  } catch {
    return url.replace(/([?&](token|phone|email|mobile|password)=)[^&]+/gi, "$1***").slice(0, 500);
  }
}

export function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER.test(k) ? "***" : v.slice(0, 500);
  }
  return out;
}

export function redactStringBody(raw: string): string {
  let out = raw.replace(
    /"(password|token|secret|api[_-]?key|phone|mobile|email|address|idCard)"\s*:\s*"[^"]*"/gi,
    '"$1":"***"',
  );
  out = out.replace(
    /(^|[&?])(phone|mobile|email|password|token|secret|api[_-]?key)=([^&\s]+)/gi,
    "$1$2=***",
  );
  out = out.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "***");
  out = out.replace(/\b1[3-9]\d{9}\b/g, "***");
  return out.slice(0, 4000);
}

export function redactForEvidence(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactStringBody(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactForEvidence(item));
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = "***";
    } else if (key === "url" && typeof val === "string") {
      out[key] = redactUrl(val);
    } else if (key === "responseHeaders" || key === "headers") {
      out[key] = redactHeaders(val as Record<string, string>);
    } else if (key === "requestBodies" || key === "responseBodies") {
      out[key] = Array.isArray(val)
        ? val.map((item) => (typeof item === "string" ? redactStringBody(item) : redactForEvidence(item)))
        : redactForEvidence(val);
    } else if (key === "requestJson" || key === "responseJson") {
      out[key] =
        typeof val === "string"
          ? redactStringBody(val)
          : val !== null && typeof val === "object"
            ? redactForEvidence(val)
            : val;
    } else {
      out[key] = redactForEvidence(val);
    }
  }
  return out;
}

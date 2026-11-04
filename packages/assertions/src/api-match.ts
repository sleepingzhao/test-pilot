export function redactRequestBody(raw: string): string {
  return raw
    .replace(/"(password|token|secret|api[_-]?key)"\s*:\s*"[^"]*"/gi, '"$1":"***"')
    .slice(0, 4000);
}

/** Shallow partial match: every key in expected must equal or substring-match in actual object. */
export function partialJsonMatch(expected: Record<string, unknown>, actual: unknown): boolean {
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  const obj = actual as Record<string, unknown>;
  for (const [key, exp] of Object.entries(expected)) {
    const act = obj[key];
    if (exp === null || typeof exp !== "object" || Array.isArray(exp)) {
      if (act !== exp) return false;
      continue;
    }
    if (!partialJsonMatch(exp as Record<string, unknown>, act)) return false;
  }
  return true;
}

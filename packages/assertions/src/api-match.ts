export function redactRequestBody(raw: string): string {
  return raw
    .replace(/"(password|token|secret|api[_-]?key)"\s*:\s*"[^"]*"/gi, '"$1":"***"')
    .slice(0, 4000);
}

/** Partial object match with strict primitives and exact-length array matching. */
function matchesValue(expected: unknown, actual: unknown): boolean {
  if (expected === null) return actual === null;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((item, index) => matchesValue(item, actual[index]));
  }
  if (typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    const obj = actual as Record<string, unknown>;
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
      matchesValue(value, obj[key]),
    );
  }
  return actual === expected;
}

/** Every key in expected must match in actual; extra object keys are allowed. */
export function partialJsonMatch(expected: Record<string, unknown>, actual: unknown): boolean {
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  return matchesValue(expected, actual);
}

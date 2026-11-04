/** Minimal JSON Schema (objects) validation for captured HTTP response bodies — no external deps. */
export function matchesJsonSchema(
  schema: Record<string, unknown>,
  value: unknown,
): { ok: true } | { ok: false; message: string } {
  const err = checkSchema(schema, value, "");
  if (err) return { ok: false, message: err };
  return { ok: true };
}

function checkSchema(schema: Record<string, unknown>, value: unknown, path: string): string | undefined {
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return `${path || "value"} must be object`;
    }
    const obj = value as Record<string, unknown>;
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === "string" && !(key in obj)) {
          return `${path || "value"} missing required property ${key}`;
        }
      }
    }
    const props = schema.properties;
    if (props && typeof props === "object" && !Array.isArray(props)) {
      for (const [key, sub] of Object.entries(props as Record<string, unknown>)) {
        if (!(key in obj)) continue;
        if (sub && typeof sub === "object" && !Array.isArray(sub)) {
          const nested = checkSchema(sub as Record<string, unknown>, obj[key], path ? `${path}.${key}` : key);
          if (nested) return nested;
        }
      }
    }
    return undefined;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path || "value"} must be array`;
    const items = schema.items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      for (let i = 0; i < value.length; i++) {
        const nested = checkSchema(items as Record<string, unknown>, value[i], `${path}[${i}]`);
        if (nested) return nested;
      }
    }
    return undefined;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") return `${path || "value"} must be string`;
    if (typeof schema.enum === "object" && Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      return `${path || "value"} not in enum`;
    }
    return undefined;
  }

  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number") return `${path || "value"} must be number`;
    if (schema.type === "integer" && !Number.isInteger(value)) {
      return `${path || "value"} must be integer`;
    }
    return undefined;
  }

  if (schema.type === "boolean") {
    if (typeof value !== "boolean") return `${path || "value"} must be boolean`;
    return undefined;
  }

  return undefined;
}

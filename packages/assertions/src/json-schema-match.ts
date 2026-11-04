import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

type AjvLike = {
  compile: (schema: object) => (value: unknown) => boolean;
  errors?: Array<{ instancePath?: string; message?: string }> | null;
};

let ajvInstance: AjvLike | undefined;

function getAjv(): AjvLike {
  if (ajvInstance) return ajvInstance;
  const AjvCtor = (Ajv2020Module as { default?: unknown }).default ?? Ajv2020Module;
  const addFormatsFn = (addFormatsModule as { default?: unknown }).default ?? addFormatsModule;
  const ajv = new (AjvCtor as new (opts: object) => AjvLike)({
    allErrors: true,
    strict: true,
    strictTypes: false,
    strictRequired: false,
    allowUnionTypes: true,
  });
  (addFormatsFn as (a: AjvLike) => void)(ajv);
  ajvInstance = ajv;
  return ajv;
}

/** Compile-time check for approval: invalid or unsupported schema documents fail validation. */
export function validateJsonSchemaDocument(
  schema: Record<string, unknown>,
): { ok: true } | { ok: false; message: string } {
  const ajv = getAjv();
  try {
    ajv.compile(schema);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export function matchesJsonSchema(
  schema: Record<string, unknown>,
  value: unknown,
): { ok: true } | { ok: false; message: string } {
  const ajv = getAjv();
  let validateFn: ((value: unknown) => boolean) & {
    errors?: Array<{ instancePath?: string; message?: string }> | null;
  };
  try {
    validateFn = ajv.compile(schema) as typeof validateFn;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `schema compile: ${message}` };
  }
  const ok = validateFn(value);
  if (ok) return { ok: true };
  const first = validateFn.errors?.[0] ?? ajv.errors?.[0];
  const where = first?.instancePath ? `${first.instancePath}: ` : "";
  return { ok: false, message: `${where}${first?.message ?? "validation failed"}` };
}

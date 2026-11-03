import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { TestIR, ValidationIssue, ValidationResult } from "./types.js";

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "../schema/test-ir.v1.schema.json");

type AjvInstance = {
  compile: (schema: object) => ((doc: unknown) => boolean) & { errors?: ValidationIssue[] };
};

function createAjv(): AjvInstance {
  const AjvCtor = (Ajv2020Module as { default?: unknown }).default ?? Ajv2020Module;
  const addFormatsFn = (addFormatsModule as { default?: unknown }).default ?? addFormatsModule;
  const ajv = new (AjvCtor as new (opts: object) => AjvInstance)({ allErrors: true, strict: false });
  (addFormatsFn as (a: AjvInstance) => void)(ajv);
  return ajv;
}

export function createValidator(): (doc: unknown) => ValidationResult {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = createAjv();
  const validate = ajv.compile(schema);

  return (doc: unknown): ValidationResult => {
    const ok = validate(doc);
    if (ok) {
      return { ok: true, value: doc as TestIR };
    }
    const issues: ValidationIssue[] = (validate.errors ?? []).map(
      (e: { instancePath?: string; message?: string }) => ({
        path: e.instancePath || "/",
        message: e.message ?? "invalid",
      }),
    );
    return { ok: false, issues };
  };
}

let cached: ReturnType<typeof createValidator> | undefined;

export function validateTestIR(doc: unknown): ValidationResult {
  cached ??= createValidator();
  return cached(doc);
}

/** Semantic checks beyond JSON Schema (e.g. human-approved for high-risk UI). */
export function validateSemantics(ir: TestIR): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (ir.assertions.length === 0) {
    issues.push({ path: "/assertions", message: "at least one assertion is required for approved runs" });
  }
  for (const [i, a] of ir.assertions.entries()) {
    if (a.type === "ui" && !a.target && !a.contains) {
      issues.push({
        path: `/assertions/${i}`,
        message: "ui assertion requires target and/or contains",
      });
    }
  }
  return issues;
}

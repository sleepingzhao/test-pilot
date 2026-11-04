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

const GENERIC_UI_TEXT = /^(成功|失败|确定|取消|保存|提交|工单|登录|首页|打开|返回|完成|密码|手机号)$/;

export function isWeakAssertionText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length < 4 || GENERIC_UI_TEXT.test(trimmed);
}

/** Page-wide assertions need specific text; otherwise they pass on any page copy. */
export function weakAssertionIssues(ir: TestIR): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [i, a] of (ir.assertions ?? []).entries()) {
    if (a.type !== "ui" || a.target) continue;
    const text = (a.contains ?? "").trim();
    if (!text) continue;
    if (isWeakAssertionText(text)) {
      issues.push({
        path: `/assertions/${i}/contains`,
        message: `整页 UI 断言过弱（"${text}"）：请指定 target，或使用至少 4 个字的稳定成功文案`,
      });
    }
  }
  return issues;
}

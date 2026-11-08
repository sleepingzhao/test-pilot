import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RequestMethod, TestIR, ValidationIssue, ValidationResult } from "./types.js";

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

const REQUEST_METHODS = new Set<RequestMethod>(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

/** Reject absolute request paths that can never be a same-origin http(s) call. */
export function requestPathIssue(path: string): string | undefined {
  const trimmed = path.trim();
  if (!trimmed) return "request step requires path";
  if (/[\u0000-\u001f\s]/.test(trimmed)) return "request path contains whitespace or control characters";
  if (trimmed.startsWith("//")) return "request path must not be protocol-relative";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "request path is not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "request path must be http(s) or a path relative to baseUrl";
  }
  if (url.username || url.password) return "request path must not include credentials";
  return undefined;
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
  let base: URL | undefined;
  if (ir.baseUrl) {
    try {
      base = new URL(ir.baseUrl);
    } catch {
      issues.push({ path: "/baseUrl", message: "baseUrl is not a valid URL" });
    }
  }
  for (const [i, step] of ir.steps.entries()) {
    if (step.action !== "request") continue;
    if (!step.method || !REQUEST_METHODS.has(step.method)) {
      issues.push({
        path: `/steps/${i}/method`,
        message: "request step requires method GET, POST, PUT, PATCH, DELETE, or HEAD",
      });
    }
    if (!step.path?.trim()) {
      issues.push({ path: `/steps/${i}/path`, message: "request step requires path" });
    } else {
      const pathIssue = requestPathIssue(step.path);
      if (pathIssue) issues.push({ path: `/steps/${i}/path`, message: pathIssue });
      else if (base && /^[a-z][a-z0-9+.-]*:/i.test(step.path.trim())) {
        const target = new URL(step.path);
        if (target.origin !== base.origin) {
          issues.push({
            path: `/steps/${i}/path`,
            message: `request path must be same-origin with baseUrl (${base.origin})`,
          });
        }
      }
    }
    if (step.body !== undefined && step.form !== undefined) {
      issues.push({ path: `/steps/${i}`, message: "request step accepts body or form, not both" });
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

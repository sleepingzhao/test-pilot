import type { TestStep } from "@testpilot/test-ir";
import { resolveValueRefEnvKey } from "@testpilot/fixtures";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type TemplateContext = {
  runId: string;
  vars: Readonly<Record<string, string>>;
  /** Logical `{{env.KEY}}` → process env var name and value. Empty string is missing. */
  lookupEnv: (logicalKey: string) => { name: string; value: string | undefined };
  /** Resolved env values. Callers redact these from errors and evidence. */
  secrets: string[];
};

export function lookupProcessEnv(logicalKey: string): { name: string; value: string | undefined } {
  const name = resolveValueRefEnvKey(`env.${logicalKey}`);
  const raw = process.env[name];
  return { name, value: raw === undefined || raw === "" ? undefined : raw };
}

export function redactSecretValues(message: string, secrets: readonly string[]): string {
  const unique = [...new Set(secrets.filter((secret) => secret.length >= 4))].sort((a, b) => b.length - a.length);
  let out = message;
  for (const secret of unique) out = out.split(secret).join("***");
  return out;
}

export function renderTemplateString(input: string, ctx: TemplateContext): string {
  const token = /\{\{([^{}]*)\}\}/g;
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = token.exec(input))) {
    out += input.slice(last, match.index);
    out += resolveToken(match[1] ?? "", ctx);
    last = match.index + match[0].length;
  }
  const tail = input.slice(last);
  if (tail.includes("{{")) throw new Error("request invalid template");
  return out + tail;
}

function resolveToken(raw: string, ctx: TemplateContext): string {
  const token = raw.trim();
  if (token === "runId") return ctx.runId;
  if (token.startsWith("env.")) {
    const logicalKey = token.slice("env.".length);
    if (!IDENT.test(logicalKey)) throw new Error("request invalid template: env key");
    const resolved = ctx.lookupEnv(logicalKey);
    if (resolved.value === undefined) {
      throw new Error(`request missing env: ${logicalKey} (${resolved.name})`);
    }
    ctx.secrets.push(resolved.value);
    return resolved.value;
  }
  if (!IDENT.test(token)) throw new Error("request invalid template");
  const value = ctx.vars[token];
  if (value === undefined) throw new Error(`request missing variable: ${token}`);
  return value;
}

function renderUnknown(value: unknown, ctx: TemplateContext): unknown {
  if (typeof value === "string") return renderTemplateString(value, ctx);
  if (Array.isArray(value)) return value.map((item) => renderUnknown(item, ctx));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = renderUnknown(item, ctx);
    return out;
  }
  return value;
}

export type RenderedRequest = {
  path: string;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
  form?: Record<string, string>;
};

export function renderRequestStep(step: TestStep, ctx: TemplateContext): RenderedRequest {
  if (!step.path) throw new Error("request requires path");
  const headers = step.headers
    ? Object.fromEntries(
        Object.entries(step.headers).map(([key, value]) => [key, renderTemplateString(value, ctx)]),
      )
    : undefined;
  const body = step.body === undefined ? undefined : renderUnknown(step.body, ctx);
  const form = step.form
    ? Object.fromEntries(Object.entries(step.form).map(([key, value]) => [key, renderTemplateString(value, ctx)]))
    : undefined;
  return {
    path: renderTemplateString(step.path, ctx),
    headers,
    body: body as RenderedRequest["body"],
    form,
  };
}

export function requestBodyForEvidence(rendered: RenderedRequest): string | undefined {
  if (typeof rendered.body === "string") return rendered.body;
  if (rendered.body !== undefined) return JSON.stringify(rendered.body);
  if (rendered.form) return new URLSearchParams(rendered.form).toString();
  return undefined;
}

export function readDotPath(value: unknown, path: string): unknown {
  if (!path.trim()) return undefined;
  let current = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) return undefined;
      current = current[Number(part)];
      continue;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function assignResponseVariables(
  step: TestStep,
  responseText: string,
  vars: Record<string, string>,
): void {
  if (step.saveAs && step.saveFields && Object.prototype.hasOwnProperty.call(step.saveFields, step.saveAs)) {
    throw new Error(`request saveAs conflicts with saveFields: ${step.saveAs}`);
  }
  if (step.saveAs) {
    if (!IDENT.test(step.saveAs)) throw new Error(`request saveAs invalid variable: ${step.saveAs}`);
    vars[step.saveAs] = responseText;
  }
  if (!step.saveFields) return;
  let json: unknown;
  try {
    json = JSON.parse(responseText);
  } catch {
    throw new Error("request saveFields: response is not JSON");
  }
  for (const [name, path] of Object.entries(step.saveFields)) {
    if (!IDENT.test(name)) throw new Error(`request saveFields invalid variable: ${name}`);
    const value = readDotPath(json, path);
    if (value === undefined || value === null) throw new Error(`request saveFields missing path: ${path}`);
    vars[name] =
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);
  }
}

import type { RequestMethod, TestIR } from "@testpilot/test-ir";
import { requestPathIssue } from "@testpilot/test-ir";

export type ApiTestCleanupInput = {
  method?: string;
  path?: string;
  body?: string | Record<string, unknown>;
};

export type ApiTestDraftInput = {
  title?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
  expectStatus?: number;
  expectContains?: string;
  expectJson?: Record<string, unknown>;
  cleanup?: ApiTestCleanupInput;
};

export type ApiTestDraft = {
  id: string;
  title: string;
  ir: TestIR;
};

export type ApiTestDraftResult =
  | { ok: true; draft: ApiTestDraft; warnings: string[] }
  | { ok: false; errors: string[] };

const METHODS = new Set<RequestMethod>(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding"]);
const MAX_BODY = 100_000;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const RUN_ID_HINT =
  "写接口建议在 path/body 中使用 {{runId}} 标记，便于清理";

/** Turns the console form into a reviewable draft. Never approves or runs it. */
export function buildApiTestDraft(input: ApiTestDraftInput): ApiTestDraftResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const method = String(input.method ?? "").trim().toUpperCase();
  if (!METHODS.has(method as RequestMethod)) {
    errors.push("method 必须是 GET/POST/PUT/PATCH/DELETE/HEAD");
  }
  const path = String(input.path ?? "").trim();
  const pathIssue = requestPathIssue(path);
  if (pathIssue) errors.push(pathIssue);

  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(input.headers ?? {})) {
    const name = rawName.trim();
    const value = String(rawValue ?? "");
    if (!name) {
      errors.push("header 名称不能为空");
      continue;
    }
    if (!HEADER_NAME.test(name)) {
      errors.push(`header 名称不合法: ${name}`);
      continue;
    }
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      errors.push(`header 不允许手动设置: ${name}`);
      continue;
    }
    if (/[\r\n]/.test(value)) {
      errors.push(`header 值不能包含换行: ${name}`);
      continue;
    }
    if (value.length > 2_000) {
      errors.push(`header 值过长: ${name}`);
      continue;
    }
    headers[name] = value;
  }

  let body: string | Record<string, unknown> | undefined;
  if (typeof input.body === "string") {
    if (input.body.length > MAX_BODY) errors.push("body 超过 100 KB");
    else if (input.body.trim()) body = input.body;
  } else if (input.body !== undefined) {
    const serialized = JSON.stringify(input.body);
    if (serialized.length > MAX_BODY) errors.push("body 超过 100 KB");
    else body = input.body;
  }

  const expectStatus = input.expectStatus ?? 200;
  if (!Number.isInteger(expectStatus) || expectStatus < 100 || expectStatus > 599) {
    errors.push("期望状态码必须是 100-599 的整数");
  }
  const expectContains = input.expectContains?.trim() ?? "";
  if (expectContains.length > 500) errors.push("响应包含文本不能超过 500 字");
  const expectJson = input.expectJson;
  if (expectJson !== undefined && (typeof expectJson !== "object" || Array.isArray(expectJson))) {
    errors.push("期望 JSON 必须是一个对象");
  }
  if (expectJson && Object.keys(expectJson).length === 0) {
    errors.push("期望 JSON 不能为空对象");
  }

  const title = (input.title?.trim() || `${method || "API"} ${path || "/"}`).slice(0, 80);

  const cleanupPath = String(input.cleanup?.path ?? "").trim();
  let cleanupMethod = String(input.cleanup?.method ?? "").trim().toUpperCase();
  let cleanupBody: string | Record<string, unknown> | undefined;
  if (cleanupPath) {
    if (!cleanupMethod) cleanupMethod = "DELETE";
    if (!METHODS.has(cleanupMethod as RequestMethod)) {
      errors.push("清理 method 必须是 GET/POST/PUT/PATCH/DELETE/HEAD");
    }
    const cleanupPathIssue = requestPathIssue(cleanupPath);
    if (cleanupPathIssue) errors.push(cleanupPathIssue);
    if (input.cleanup?.body !== undefined) {
      if (typeof input.cleanup.body === "string") {
        if (input.cleanup.body.length > MAX_BODY) errors.push("清理 body 超过 100 KB");
        else if (input.cleanup.body.trim()) cleanupBody = input.cleanup.body;
      } else {
        const serialized = JSON.stringify(input.cleanup.body);
        if (serialized.length > MAX_BODY) errors.push("清理 body 超过 100 KB");
        else cleanupBody = input.cleanup.body;
      }
    }
  }

  if (WRITE_METHODS.has(method)) {
    const bodyText =
      typeof body === "string" ? body : body !== undefined ? JSON.stringify(body) : "";
    if (!path.includes("{{runId}}") && !bodyText.includes("{{runId}}")) {
      warnings.push(RUN_ID_HINT);
    }
  }

  if (errors.length) return { ok: false, errors };

  const callStep: TestIR["steps"][number] = {
    id: "call",
    action: "request",
    method: method as RequestMethod,
    path,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
  };

  if (cleanupPath && cleanupPath.includes("{{createdId}}")) {
    const existing = (callStep as { saveFields?: Record<string, string> }).saveFields;
    if (!existing?.createdId) {
      (callStep as { saveFields?: Record<string, string> }).saveFields = {
        ...existing,
        createdId: "id",
      };
    }
  }

  const id = draftId(title);
  const ir: TestIR = {
    id,
    version: 1,
    platform: "web",
    steps: [callStep],
    assertions: [
      {
        id: "response",
        type: "api",
        provider: "captured-http",
        stepRef: "call",
        expect: {
          statusCode: expectStatus,
          ...(expectContains ? { responseBodyContains: expectContains } : {}),
          ...(expectJson ? { responseJsonBody: expectJson } : {}),
        },
        oracle: "api-contract",
      },
    ],
    policy: { screenshots: "on-failure" },
  };

  if (cleanupPath) {
    ir.teardownSteps = [
      {
        id: "cleanup",
        action: "request",
        method: cleanupMethod as RequestMethod,
        path: cleanupPath,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(cleanupBody !== undefined ? { body: cleanupBody } : {}),
      },
    ];
    ir.policy = { ...ir.policy, cleanup: "always" };
  }

  return { ok: true, draft: { id, title, ir }, warnings };
}

function draftId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const stamp = Date.now().toString(36);
  return `api-${slug || "test"}-${stamp}`;
}

import { parse as parseYaml } from "yaml";

export type OpenApiOperation = {
  key: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  path: string;
  operationId?: string;
  summary?: string;
  deprecated?: boolean;
};

export type OpenApiRequestDraft = {
  method: OpenApiOperation["method"];
  path: string;
  headers: Record<string, string>;
  body?: string;
  serverUrl?: string;
  warnings: string[];
};

export type OpenApiParseResult =
  | { ok: true; title?: string; version?: string; servers: string[]; operations: OpenApiOperation[] }
  | { ok: false; error: string };

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head"] as const;
type HttpMethodLower = (typeof HTTP_METHODS)[number];
type HttpMethodUpper = OpenApiOperation["method"];

const OPERATION_LIMIT = 500;
const REF_DEPTH_LIMIT = 8;
const SCHEMA_SAMPLE_DEPTH = 5;

const SENSITIVE_HEADERS = new Set(["authorization", "cookie"]);
const DISPLAY_HEADER_NAMES: Record<string, string> = {
  authorization: "Authorization",
  cookie: "Cookie",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeJsonPointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveJsonPointer(doc: unknown, pointer: string): unknown {
  if (!pointer.startsWith("#/")) return undefined;
  const raw = pointer.slice(2);
  if (!raw) return doc;
  const parts = raw.split("/").map(decodeJsonPointerToken);
  let cur: unknown = doc;
  for (const part of parts) {
    if (!isRecord(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function isExternalRef(ref: string): boolean {
  if (!ref.startsWith("#/")) return true;
  if (/^https?:\/\//i.test(ref)) return true;
  if (ref.includes("#") && !ref.startsWith("#")) return true;
  return false;
}

function resolveValue(
  doc: unknown,
  value: unknown,
  depth: number,
  warnings: string[],
): unknown {
  if (depth > REF_DEPTH_LIMIT) return value;
  if (!isRecord(value) || typeof value.$ref !== "string") return value;
  const ref = value.$ref;
  if (isExternalRef(ref)) {
    warnings.push("已跳过外部或远程 $ref（不会在本地解析）");
    return value;
  }
  const resolved = resolveJsonPointer(doc, ref);
  if (resolved === undefined) {
    warnings.push("无法解析本地 $ref");
    return value;
  }
  return resolveValue(doc, resolved, depth + 1, warnings);
}

function parseOpenApiDocument(text: string): { ok: true; doc: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: "请粘贴 OpenAPI 文档" };
  }

  let doc: unknown;
  try {
    doc = JSON.parse(trimmed) as unknown;
  } catch {
    try {
      doc = parseYaml(trimmed, { prettyErrors: false });
    } catch {
      return { ok: false, error: "无法解析 OpenAPI 文档（JSON/YAML 格式错误）" };
    }
  }

  if (!isRecord(doc)) {
    return { ok: false, error: "无法解析 OpenAPI 文档（JSON/YAML 格式错误）" };
  }

  if (typeof doc.swagger === "string" && doc.swagger.startsWith("2")) {
    return { ok: false, error: "只支持 OpenAPI 3.x，Swagger 2.0 请先转换" };
  }

  if (typeof doc.openapi !== "string" || !doc.openapi.startsWith("3.")) {
    return { ok: false, error: "无法解析 OpenAPI 文档（JSON/YAML 格式错误）" };
  }

  if (!isRecord(doc.paths)) {
    return { ok: false, error: "无法解析 OpenAPI 文档（JSON/YAML 格式错误）" };
  }

  return { ok: true, doc };
}

function resolveServerUrl(
  server: Record<string, unknown>,
): { url: string } | { skip: true } {
  const rawUrl = typeof server.url === "string" ? server.url : "";
  if (!rawUrl) return { skip: true };
  let url = rawUrl;
  const variables = server.variables;
  if (isRecord(variables)) {
    for (const [name, def] of Object.entries(variables)) {
      if (!isRecord(def)) continue;
      const placeholder = `{${name}}`;
      if (!url.includes(placeholder)) continue;
      if (typeof def.default !== "string") {
        return { skip: true };
      }
      url = url.split(placeholder).join(def.default);
    }
  }
  return { url };
}

function collectServers(doc: Record<string, unknown>): string[] {
  const servers: string[] = [];
  const rawServers = doc.servers;
  if (!Array.isArray(rawServers)) return servers;
  for (const item of rawServers) {
    if (!isRecord(item)) continue;
    const resolved = resolveServerUrl(item);
    if ("url" in resolved) servers.push(resolved.url);
  }
  return servers;
}

function toUpperMethod(method: HttpMethodLower): HttpMethodUpper {
  return method.toUpperCase() as HttpMethodUpper;
}

export function parseOpenApi(text: string): OpenApiParseResult {
  const parsed = parseOpenApiDocument(text);
  if (!parsed.ok) return parsed;

  const { doc } = parsed;
  const info = isRecord(doc.info) ? doc.info : undefined;
  const title = typeof info?.title === "string" ? info.title : undefined;
  const version = typeof info?.version === "string" ? info.version : undefined;
  const servers = collectServers(doc);

  const operations: OpenApiOperation[] = [];
  const seenKeys = new Set<string>();

  const paths = doc.paths as Record<string, unknown>;
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!isRecord(op)) continue;
      const key = `${toUpperMethod(method)} ${path}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      if (operations.length >= OPERATION_LIMIT) {
        return { ok: false, error: "OpenAPI 文档操作过多（上限 500）" };
      }
      const operation: OpenApiOperation = {
        key,
        method: toUpperMethod(method),
        path,
      };
      if (typeof op.operationId === "string") operation.operationId = op.operationId;
      if (typeof op.summary === "string") operation.summary = op.summary;
      if (op.deprecated === true) operation.deprecated = true;
      operations.push(operation);
    }
  }

  operations.sort((a, b) => a.key.localeCompare(b.key));

  return { ok: true, title, version, servers, operations };
}

function firstExampleValue(examples: unknown): unknown {
  if (!isRecord(examples)) return undefined;
  for (const item of Object.values(examples)) {
    if (!isRecord(item)) continue;
    if ("value" in item) return item.value;
  }
  return undefined;
}

function parameterSampleValue(param: Record<string, unknown>): unknown {
  if ("example" in param) return param.example;
  const fromExamples = firstExampleValue(param.examples);
  if (fromExamples !== undefined) return fromExamples;
  const schema = param.schema;
  if (isRecord(schema)) {
    if ("example" in schema) return schema.example;
    if ("default" in schema) return schema.default;
    const en = schema.enum;
    if (Array.isArray(en) && en.length > 0) return en[0];
  }
  return undefined;
}

function sampleFromSchema(schemaIn: unknown, depth: number, doc: unknown, warnings: string[]): unknown {
  if (depth > SCHEMA_SAMPLE_DEPTH) return undefined;
  const schema = resolveValue(doc, schemaIn, 0, warnings);
  if (!isRecord(schema)) return undefined;

  if ("example" in schema) return schema.example;
  if ("default" in schema) return schema.default;
  const en = schema.enum;
  if (Array.isArray(en) && en.length > 0) return en[0];

  const type = schema.type;
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return 0;
  if (type === "boolean") return false;
  if (type === "array") {
    const item = sampleFromSchema(schema.items, depth + 1, doc, warnings);
    return item === undefined ? [] : [item];
  }
  if (type === "object" || isRecord(schema.properties)) {
    const props = isRecord(schema.properties) ? schema.properties : {};
    const out: Record<string, unknown> = {};
    for (const [name, propSchema] of Object.entries(props)) {
      const val = sampleFromSchema(propSchema, depth + 1, doc, warnings);
      if (val !== undefined) out[name] = val;
    }
    return out;
  }
  return undefined;
}

function mergeParameters(
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
  doc: unknown,
  warnings: string[],
): Record<string, unknown>[] {
  const byKey = new Map<string, Record<string, unknown>>();

  const addList = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      const param = resolveValue(doc, raw, 0, warnings);
      if (!isRecord(param)) continue;
      const name = typeof param.name === "string" ? param.name : "";
      const loc = typeof param.in === "string" ? param.in : "";
      if (!name || !loc) continue;
      byKey.set(`${loc}:${name}`, param);
    }
  };

  addList(pathItem.parameters);
  addList(operation.parameters);
  return [...byKey.values()];
}

function pickRequestBodyContent(
  requestBody: Record<string, unknown>,
): { mediaType: string; media: Record<string, unknown> } | undefined {
  const content = requestBody.content;
  if (!isRecord(content)) return undefined;
  const json = content["application/json"];
  if (isRecord(json)) return { mediaType: "application/json", media: json };
  for (const [mediaType, media] of Object.entries(content)) {
    if (isRecord(media)) return { mediaType, media };
  }
  return undefined;
}

function serializeBody(mediaType: string, value: unknown): string {
  if (mediaType.includes("json")) {
    return JSON.stringify(value, null, 2);
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function bodyFromMedia(
  media: Record<string, unknown>,
  mediaType: string,
  doc: unknown,
  warnings: string[],
): string | undefined {
  if ("example" in media) {
    return serializeBody(mediaType, media.example);
  }
  const exVal = firstExampleValue(media.examples);
  if (exVal !== undefined) {
    return serializeBody(mediaType, exVal);
  }
  if (isRecord(media.schema)) {
    const fromSchema = sampleFromSchema(media.schema, 0, doc, warnings);
    if (fromSchema !== undefined) {
      return serializeBody(mediaType, fromSchema);
    }
  }
  return undefined;
}

function isAbsoluteHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function parseOperationKey(key: string): { method: HttpMethodUpper; path: string } | null {
  const space = key.indexOf(" ");
  if (space <= 0) return null;
  const method = key.slice(0, space).toUpperCase();
  const path = key.slice(space + 1);
  const allowed = new Set<string>(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
  if (!allowed.has(method) || !path) return null;
  return { method: method as HttpMethodUpper, path };
}

export function buildOpenApiRequest(
  text: string,
  operationKey: string,
): { ok: true; request: OpenApiRequestDraft } | { ok: false; error: string } {
  const parsed = parseOpenApiDocument(text);
  if (!parsed.ok) return parsed;

  const opKey = parseOperationKey(operationKey);
  if (!opKey) {
    return { ok: false, error: "未找到该操作" };
  }

  const { doc } = parsed;
  const paths = doc.paths as Record<string, unknown>;
  const pathItem = paths[opKey.path];
  if (!isRecord(pathItem)) {
    return { ok: false, error: "未找到该操作" };
  }

  const methodLower = opKey.method.toLowerCase() as HttpMethodLower;
  const operation = pathItem[methodLower];
  if (!isRecord(operation)) {
    return { ok: false, error: "未找到该操作" };
  }

  const warnings: string[] = [];
  const headers: Record<string, string> = {};
  let path = opKey.path;

  const params = mergeParameters(pathItem, operation, doc, warnings);
  const queryParts: string[] = [];

  const droppedAuth: string[] = [];

  for (const param of params) {
    const loc = typeof param.in === "string" ? param.in : "";
    const name = typeof param.name === "string" ? param.name : "";
    if (!name) continue;

    const required = param.required === true;
    const value = parameterSampleValue(param);

    if (loc === "path") {
      const placeholder = `{${name}}`;
      if (!path.includes(placeholder)) continue;
      if (value === undefined || value === null) {
        warnings.push(`路径参数 {${name}} 缺少示例，请手动填写`);
        continue;
      }
      path = path.split(placeholder).join(encodeURIComponent(String(value)));
      continue;
    }

    if (loc === "query") {
      if (value === undefined || value === null) {
        if (required) {
          warnings.push(`查询参数 ${name} 缺少示例，请手动填写`);
        }
        continue;
      }
      queryParts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
      continue;
    }

    if (loc === "header") {
      const key = name.toLowerCase();
      if (SENSITIVE_HEADERS.has(key)) {
        const display = DISPLAY_HEADER_NAMES[key] ?? name;
        if (!droppedAuth.includes(display)) droppedAuth.push(display);
        continue;
      }
      if (value === undefined || value === null) {
        if (required) {
          warnings.push(`请求头 ${name} 缺少示例，请手动填写`);
        }
        continue;
      }
      headers[name] = String(value);
    }
  }

  if (droppedAuth.length > 0) {
    warnings.push(`已忽略鉴权头：请用 API 环境配置`);
  }

  if (queryParts.length > 0) {
    path = `${path}${path.includes("?") ? "&" : "?"}${queryParts.join("&")}`;
  }

  let body: string | undefined;
  let contentType: string | undefined;

  if (isRecord(operation.requestBody)) {
    const rb = resolveValue(doc, operation.requestBody, 0, warnings);
    if (isRecord(rb)) {
      const picked = pickRequestBodyContent(rb);
      if (picked) {
        contentType = picked.mediaType;
        body = bodyFromMedia(picked.media, picked.mediaType, doc, warnings);
      }
    }
  }

  if (contentType && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = contentType;
  }

  let serverUrl: string | undefined;
  const serverList: Record<string, unknown>[] = [];
  if (Array.isArray(doc.servers)) {
    for (const s of doc.servers) {
      if (isRecord(s)) serverList.push(s);
    }
  }
  if (serverList.length === 0 && isRecord(pathItem.servers)) {
    // path-level only handled if array on pathItem
  }
  if (Array.isArray(pathItem.servers)) {
    for (const s of pathItem.servers) {
      if (isRecord(s)) serverList.push(s);
    }
  }

  let relativeBase: string | undefined;
  const docServers = Array.isArray(doc.servers) ? doc.servers : [];
  for (const server of serverList.length > 0 ? serverList : docServers) {
    if (!isRecord(server)) continue;
    const rawUrl = typeof server.url === "string" ? server.url : "";
    if (!rawUrl) continue;

    let url = rawUrl;
    let hasUnresolved = false;
    if (isRecord(server.variables)) {
      for (const [name, def] of Object.entries(server.variables)) {
        if (!isRecord(def)) continue;
        const placeholder = `{${name}}`;
        if (!url.includes(placeholder)) continue;
        if (typeof def.default !== "string") {
          hasUnresolved = true;
          continue;
        }
        url = url.split(placeholder).join(def.default);
      }
    }
    if (hasUnresolved || /\{[^}]+\}/.test(url)) {
      warnings.push("服务器 URL 含有未解析变量，请手动选择目标环境");
    }

    if (isAbsoluteHttpUrl(url)) {
      serverUrl = url.replace(/\/$/, "");
      break;
    }
    relativeBase = url.startsWith("/") ? url.replace(/\/$/, "") : `/${url.replace(/\/$/, "")}`;
    warnings.push("服务器地址是相对路径，请手动选择目标环境");
    break;
  }

  if (relativeBase) {
    const joined =
      relativeBase === "/"
        ? path
        : `${relativeBase}${path.startsWith("/") ? path : `/${path}`}`;
    path = joined;
  }

  if (!serverUrl && !relativeBase && serverList.length === 0 && Array.isArray(doc.servers) && doc.servers.length === 0) {
    // no servers in spec — ok
  }

  const request: OpenApiRequestDraft = {
    method: opKey.method,
    path,
    headers,
    warnings,
  };
  if (body !== undefined) request.body = body;
  if (serverUrl) request.serverUrl = serverUrl;

  return { ok: true, request };
}
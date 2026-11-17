import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenApiRequest, parseOpenApi } from "./openapi-import.js";

const JSON_SPEC = `{
  "openapi": "3.0.0",
  "info": { "title": "Orders API", "version": "2.1.0" },
  "servers": [{ "url": "https://api.example.com" }],
  "paths": {
    "/api/items/{id}": {
      "get": {
        "summary": "Get item",
        "deprecated": true,
        "parameters": [
          { "name": "id", "in": "path", "required": true, "schema": { "type": "string" }, "example": "item-42" }
        ],
        "responses": { "200": { "description": "OK" } }
      }
    },
    "/api/items": {
      "get": { "summary": "List", "responses": { "200": { "description": "OK" } } },
      "post": {
        "summary": "Create",
        "requestBody": {
          "content": {
            "application/json": {
              "example": { "name": "from-example" }
            }
          }
        },
        "responses": { "201": { "description": "Created" } }
      }
    }
  }
}`;

const YAML_SPEC = `
openapi: 3.0.0
info:
  title: YAML API
  version: "1.0"
servers:
  - url: https://yaml.example.com
paths:
  /health:
    get:
      summary: Health check
      responses:
        "200":
          description: OK
`;

test("JSON spec parses and lists operations with keys", () => {
  const r = parseOpenApi(JSON_SPEC);
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("expected ok");
  assert.equal(r.title, "Orders API");
  assert.equal(r.version, "2.1.0");
  assert.deepEqual(r.servers, ["https://api.example.com"]);
  const keys = r.operations.map((o) => o.key);
  assert.ok(keys.includes("GET /api/items"));
  assert.ok(keys.includes("POST /api/items"));
  assert.ok(keys.includes("GET /api/items/{id}"));
  const getById = r.operations.find((o) => o.key === "GET /api/items/{id}");
  assert.equal(getById?.deprecated, true);
});

test("YAML spec parses the same way", () => {
  const r = parseOpenApi(YAML_SPEC);
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("expected ok");
  assert.equal(r.title, "YAML API");
  assert.equal(r.operations.length, 1);
  assert.equal(r.operations[0]!.key, "GET /health");
});

const REF_SPEC = `{
  "openapi": "3.0.0",
  "info": { "title": "Ref", "version": "1" },
  "paths": {
    "/ref": {
      "get": {
        "parameters": [{ "$ref": "#/components/parameters/PageParam" }],
        "requestBody": { "$ref": "#/components/requestBodies/CreateBody" },
        "responses": { "200": { "description": "OK" } }
      }
    }
  },
  "components": {
    "parameters": {
      "PageParam": {
        "name": "page",
        "in": "query",
        "required": true,
        "schema": { "type": "integer" },
        "example": 2
      }
    },
    "requestBodies": {
      "CreateBody": {
        "content": {
          "application/json": {
            "schema": { "$ref": "#/components/schemas/Item" },
            "example": { "name": "ref-body" }
          }
        }
      }
    },
    "schemas": {
      "Item": {
        "type": "object",
        "properties": { "name": { "type": "string" } }
      }
    }
  }
}`;

test("refs to components resolve", () => {
  const built = buildOpenApiRequest(REF_SPEC, "GET /ref");
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("expected ok");
  assert.match(built.request.path, /page=2/);
  assert.equal(built.request.body, '{\n  "name": "ref-body"\n}');
});

test("path query header examples are filled and encoded", () => {
  const spec = `{
    "openapi": "3.0.0",
    "paths": {
      "/search": {
        "get": {
          "parameters": [
            { "name": "q", "in": "query", "schema": { "type": "string" }, "example": "hello world" },
            { "name": "X-Trace", "in": "header", "schema": { "type": "string" }, "example": "trace-1" }
          ],
          "responses": { "200": { "description": "OK" } }
        }
      }
    }
  }`;
  const built = buildOpenApiRequest(spec, "GET /search");
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("expected ok");
  assert.match(built.request.path, /q=hello%20world/);
  assert.equal(built.request.headers["X-Trace"], "trace-1");
});

test("JSON body example is used", () => {
  const built = buildOpenApiRequest(JSON_SPEC, "POST /api/items");
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("expected ok");
  assert.match(built.request.body ?? "", /from-example/);
});

test("schema-generated body fallback works", () => {
  const spec = `{
    "openapi": "3.0.0",
    "paths": {
      "/items": {
        "post": {
          "requestBody": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "name": { "type": "string" },
                    "count": { "type": "integer" },
                    "active": { "type": "boolean" }
                  }
                }
              }
            }
          },
          "responses": { "200": { "description": "OK" } }
        }
      }
    }
  }`;
  const built = buildOpenApiRequest(spec, "POST /items");
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("expected ok");
  const body = JSON.parse(built.request.body ?? "{}") as Record<string, unknown>;
  assert.equal(body.name, "string");
  assert.equal(body.count, 0);
  assert.equal(body.active, false);
});

test("missing path parameter leaves placeholder and warning", () => {
  const spec = `{
    "openapi": "3.0.0",
    "paths": {
      "/items/{id}": {
        "get": {
          "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }],
          "responses": { "200": { "description": "OK" } }
        }
      }
    }
  }`;
  const built = buildOpenApiRequest(spec, "GET /items/{id}");
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("expected ok");
  assert.match(built.request.path, /\{id\}/);
  assert.ok(built.request.warnings.some((w) => w.includes("路径参数 {id}")));
});

test("Authorization header example is dropped with warning and no secret in JSON", () => {
  const secret = "SUPER_SECRET_OPENAPI_TOKEN";
  const spec = `{
    "openapi": "3.0.0",
    "paths": {
      "/secure": {
        "get": {
          "parameters": [
            { "name": "Authorization", "in": "header", "example": "Bearer ${secret}" },
            { "name": "Accept", "in": "header", "example": "application/json" }
          ],
          "responses": { "200": { "description": "OK" } }
        }
      }
    }
  }`;
  const built = buildOpenApiRequest(spec, "GET /secure");
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("expected ok");
  assert.equal(built.request.headers.Authorization, undefined);
  assert.equal(built.request.headers.Accept, "application/json");
  assert.ok(built.request.warnings.some((w) => w.includes("已忽略鉴权头")));
  const json = JSON.stringify(built);
  assert.equal(json.includes(secret), false);
});

test("Swagger 2.0 and invalid text produce clear errors", () => {
  const swagger2 = parseOpenApi('{ "swagger": "2.0", "paths": {} }');
  assert.equal(swagger2.ok, false);
  if (swagger2.ok) throw new Error("expected error");
  assert.equal(swagger2.error, "只支持 OpenAPI 3.x，Swagger 2.0 请先转换");

  const invalid = parseOpenApi("not:{yaml");
  assert.equal(invalid.ok, false);
  if (invalid.ok) throw new Error("expected error");
  assert.match(invalid.error!, /无法解析/);

  const empty = parseOpenApi("   ");
  assert.equal(empty.ok, false);
  if (empty.ok) throw new Error("expected error");
  assert.equal(empty.error, "请粘贴 OpenAPI 文档");
});

test("external $ref is skipped with warning", () => {
  const spec = `{
    "openapi": "3.0.0",
    "paths": {
      "/ext": {
        "get": {
          "parameters": [{ "$ref": "https://evil.example.com/spec.json#/components/parameters/X" }],
          "responses": { "200": { "description": "OK" } }
        }
      }
    }
  }`;
  const built = buildOpenApiRequest(spec, "GET /ext");
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("expected ok");
  assert.ok(built.request.warnings.some((w) => w.includes("外部") || w.includes("$ref")));
});

test("operation count limit", () => {
  const paths: Record<string, unknown> = {};
  for (let i = 0; i < 501; i++) {
    paths[`/p${i}`] = { get: { responses: { "200": { description: "OK" } } } };
  }
  const spec = JSON.stringify({ openapi: "3.0.0", paths });
  const r = parseOpenApi(spec);
  assert.equal(r.ok, false);
  if (r.ok) throw new Error("expected error");
  assert.match(r.error!, /500/);
});

test("path parameter example replaces segment", () => {
  const built = buildOpenApiRequest(JSON_SPEC, "GET /api/items/{id}");
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("expected ok");
  assert.equal(built.request.path, "/api/items/item-42");
});

test("serverUrl from absolute server", () => {
  const built = buildOpenApiRequest(JSON_SPEC, "GET /api/items");
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("expected ok");
  assert.equal(built.request.serverUrl, "https://api.example.com");
});

test("unknown operation key returns error", () => {
  const built = buildOpenApiRequest(JSON_SPEC, "DELETE /missing");
  assert.equal(built.ok, false);
  if (built.ok) throw new Error("expected error");
  assert.equal(built.error, "未找到该操作");
});
test("skips path keys that are not root-relative", () => {
  const spec = JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Paths", version: "1" },
    paths: {
      "/ok": { get: { responses: { "200": { description: "OK" } } } },
      "items": { get: { responses: { "200": { description: "OK" } } } },
      "//evil.example/api": { get: { responses: { "200": { description: "OK" } } } },
    },
  });
  const parsed = parseOpenApi(spec);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.operations.map((o) => o.key), ["GET /ok"]);
});

test("server URLs with credentials are ignored", () => {
  const spec = JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Creds", version: "1" },
    servers: [{ url: "https://user:pass@api.example.com" }],
    paths: { "/x": { get: { responses: { "200": { description: "OK" } } } } },
  });
  const built = buildOpenApiRequest(spec, "GET /x");
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.request.serverUrl, undefined);
  assert.match(built.request.warnings.join("\n"), /包含凭据/);
  assert.equal(JSON.stringify(built.request).includes("user:pass"), false);
});

test("header values with CRLF are skipped", () => {
  const spec = JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Headers", version: "1" },
    paths: {
      "/x": {
        get: {
          parameters: [
            { name: "X-Test", in: "header", example: "a\r\nb" },
            { name: "X-Ok", in: "header", example: "fine" },
          ],
          responses: { "200": { description: "OK" } },
        },
      },
    },
  });
  const built = buildOpenApiRequest(spec, "GET /x");
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.request.headers, { "X-Ok": "fine" });
  assert.match(built.request.warnings.join("\n"), /X-Test.*含换行/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { parseCurlCommand } from "./curl-import.js";

function assertOk(raw: string) {
  const result = parseCurlCommand(raw);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected ok");
  return result;
}

test("quoted GET URL", () => {
  const r = assertOk("curl 'https://api.example.com/orders?page=1'");
  assert.equal(r.request.method, "GET");
  assert.equal(r.request.url, "https://api.example.com/orders?page=1");
  assert.deepEqual(r.request.headers, {});
});

test("headers and -X POST", () => {
  const r = assertOk(
    "curl -X POST 'https://api.example.com/orders' -H 'Accept: application/json' -H 'Content-Type: application/json'",
  );
  assert.equal(r.request.method, "POST");
  assert.equal(r.request.headers.Accept, "application/json");
  assert.equal(r.request.headers["Content-Type"], "application/json");
});

test("inferred POST from -d", () => {
  const r = assertOk("curl https://api.example.com/orders -d name=test");
  assert.equal(r.request.method, "POST");
  assert.equal(r.request.body, "name=test");
});

test("multiple -d joined with &", () => {
  const r = assertOk("curl https://api.example.com/orders -d a=1 -d b=2");
  assert.equal(r.request.body, "a=1&b=2");
});

test("--data-raw JSON kept verbatim", () => {
  const json = '{"name":"测试","n":1}';
  const r = assertOk(`curl https://api.example.com/orders --data-raw '${json}'`);
  assert.equal(r.request.body, json);
});

test("line-continuation multi-line command", () => {
  const r = assertOk(`curl 'https://api.example.com/x' \\
  -H 'X-Trace: 1'`);
  assert.equal(r.request.url, "https://api.example.com/x");
  assert.equal(r.request.headers["X-Trace"], "1");
});

test("--url flag", () => {
  const r = assertOk("curl --url https://api.example.com/items --url https://api.example.com/final");
  assert.equal(r.request.url, "https://api.example.com/final");
});

test("later duplicate header wins case-insensitively", () => {
  const r = assertOk(
    "curl https://api.example.com/x -H 'X-Req: old' -H 'x-req: new'",
  );
  assert.equal(r.request.headers["x-req"], "new");
});

test("query string retained", () => {
  const r = assertOk("curl 'https://api.example.com/search?q=hello%20world&page=2'");
  assert.equal(r.request.url, "https://api.example.com/search?q=hello%20world&page=2");
});

test("empty input", () => {
  const r = parseCurlCommand("   ");
  assert.equal(r.ok, false);
  if (r.ok) throw new Error("expected error");
  assert.equal(r.error, "请粘贴 cURL 命令");
});

test("not a curl string", () => {
  const r = parseCurlCommand("wget https://example.com");
  assert.equal(r.ok, false);
  if (r.ok) throw new Error("expected error");
  assert.equal(r.error, "看起来不是 cURL 命令");
});

test("no URL", () => {
  const r = parseCurlCommand("curl -X GET");
  assert.equal(r.ok, false);
  if (r.ok) throw new Error("expected error");
  assert.equal(r.error, "没有找到 URL");
});

test("unclosed quote", () => {
  const r = parseCurlCommand("curl 'https://example.com");
  assert.equal(r.ok, false);
  if (r.ok) throw new Error("expected error");
  assert.equal(r.error, "cURL 里的引号没有闭合");
});

test("ftp URL", () => {
  const r = parseCurlCommand("curl ftp://files.example.com/data");
  assert.equal(r.ok, false);
  if (r.ok) throw new Error("expected error");
  assert.equal(r.error, "只支持 http(s) URL");
});

test("relative URL", () => {
  const r = parseCurlCommand("curl /api/items");
  assert.equal(r.ok, false);
  if (r.ok) throw new Error("expected error");
  assert.equal(r.error, "URL 不是绝对地址");
});

test("header value with CRLF", () => {
  const r = parseCurlCommand('curl https://example.com -H "X-Bad: line1\r\nline2"');
  assert.equal(r.ok, false);
  if (r.ok) throw new Error("expected error");
  assert.equal(r.error, "请求头包含换行");
});

test("security: auth headers dropped with single warning and no secret values", () => {
  const secret = "SECRET123_should_not_leak";
  const r = assertOk(
    `curl 'https://api.example.com/orders' -H 'Authorization: Bearer ${secret}' -H 'Cookie: sid=${secret}' -H 'x-api-key: ${secret}' -H 'Accept: application/json'`,
  );
  assert.equal(r.request.headers.Authorization, undefined);
  assert.equal(r.request.headers.Cookie, undefined);
  assert.equal(r.request.headers["x-api-key"], undefined);
  assert.equal(r.request.headers.Accept, "application/json");
  const authWarnings = r.warnings.filter((w) => w.startsWith("已忽略鉴权头"));
  assert.equal(authWarnings.length, 1);
  assert.match(authWarnings[0]!, /Authorization/);
  assert.match(authWarnings[0]!, /Cookie/);
  assert.match(authWarnings[0]!, /X-Api-Key|x-api-key/i);
  const json = JSON.stringify(r);
  assert.equal(json.includes(secret), false);
});

test("security: -u and oauth2-bearer values absent", () => {
  const pass = "user:ultra_secret_pass";
  const token = "oauth_token_xyz";
  const r = assertOk(
    `curl https://api.example.com/x -u '${pass}' --oauth2-bearer '${token}'`,
  );
  const json = JSON.stringify(r);
  assert.equal(json.includes("ultra_secret_pass"), false);
  assert.equal(json.includes("oauth_token_xyz"), false);
  assert.ok(r.warnings.some((w) => w.includes("-u")));
  assert.ok(r.warnings.some((w) => w.includes("--oauth2-bearer")));
});

test("env assignment prefix before curl", () => {
  const r = assertOk("FOO=1 curl 'https://api.example.com/health'");
  assert.equal(r.request.url, "https://api.example.com/health");
});

test("double-quote escapes", () => {
  const r = assertOk('curl "https://api.example.com/a\\"b"');
  assert.equal(r.request.url, 'https://api.example.com/a"b');
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildApiTestDraft } from "./api-test-draft.js";

test("buildApiTestDraft creates a request step and a stepRef assertion", () => {
  const result = buildApiTestDraft({
    title: "创建订单",
    method: "post",
    path: "/api/orders",
    headers: { "x-trace": "abc" },
    body: { sku: "A-1", qty: 2 },
    expectStatus: 201,
    expectContains: "order-1",
    expectJson: { ok: true },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { ir } = result.draft;
  assert.match(result.draft.id, /^api-[a-z0-9-]+$/);
  assert.deepEqual(ir.steps[0], {
    id: "call",
    action: "request",
    method: "POST",
    path: "/api/orders",
    headers: { "x-trace": "abc" },
    body: { sku: "A-1", qty: 2 },
  });
  assert.deepEqual(ir.assertions[0], {
    id: "response",
    type: "api",
    provider: "captured-http",
    stepRef: "call",
    expect: {
      statusCode: 201,
      responseBodyContains: "order-1",
      responseJsonBody: { ok: true },
    },
    oracle: "api-contract",
  });
});

test("buildApiTestDraft defaults to 200 and a readable title", () => {
  const result = buildApiTestDraft({ method: "GET", path: "/api/health" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.draft.title, "GET /api/health");
  assert.deepEqual(result.draft.ir.assertions[0]?.expect, { statusCode: 200 });
});

test("buildApiTestDraft rejects unsafe or malformed input (negative)", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ method: "TRACE", path: "/api/x" }, /method/],
    [{ method: "GET", path: "//evil.example/x" }, /protocol-relative/],
    [{ method: "GET", path: "/api/x", headers: { "bad header": "1" } }, /header 名称不合法/],
    [{ method: "GET", path: "/api/x", headers: { host: "evil" } }, /不允许手动设置/],
    [{ method: "GET", path: "/api/x", headers: { "x-a": "a\r\nb" } }, /不能包含换行/],
    [{ method: "GET", path: "/api/x", expectStatus: 700 }, /状态码/],
    [{ method: "GET", path: "/api/x", expectJson: [] }, /必须是一个对象/],
    [{ method: "GET", path: "/api/x", expectJson: {} }, /不能为空对象/],
    [{ method: "GET", path: "/api/x", body: "x".repeat(100_001) }, /100 KB/],
  ];
  for (const [input, pattern] of cases) {
    const result = buildApiTestDraft(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    if (result.ok) continue;
    assert.ok(
      result.errors.some((message) => pattern.test(message)),
      `${JSON.stringify(input)} -> ${result.errors.join(", ")}`,
    );
  }
});

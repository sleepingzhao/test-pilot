import assert from "node:assert/strict";
import test from "node:test";
import { createDemoServer } from "./server.mjs";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server.address().port);
    });
  });
}

async function jsonFetch(port, method, pathname, body) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

test("items CRUD in memory", async () => {
  const server = createDemoServer();
  const port = await listen(server);
  try {
    const empty = await jsonFetch(port, "GET", "/api/items");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { items: [] });

    const created = await jsonFetch(port, "POST", "/api/items", { name: "alpha" });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, "alpha");
    assert.match(created.body.id, /^[0-9a-f-]{36}$/i);

    const listed = await jsonFetch(port, "GET", "/api/items");
    assert.equal(listed.body.items.length, 1);

    const deleted = await jsonFetch(port, "DELETE", `/api/items/${created.body.id}`);
    assert.equal(deleted.status, 204);

    const missing = await jsonFetch(port, "DELETE", `/api/items/${created.body.id}`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

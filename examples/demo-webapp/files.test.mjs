import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createDemoServer } from "./server.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function upload(base, bytes, type, filename) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), filename);
  return fetch(`${base}/api/files`, { method: "POST", body: form });
}

describe("demo /api/files", { concurrency: 1 }, () => {
  /** @type {import("node:http").Server} */
  let server;
  let base;

  test.before(async () => {
    server = createDemoServer();
    const port = await listen(server);
    base = `http://127.0.0.1:${port}`;
  });

  test.after(async () => {
    await close(server);
  });

  test("GET /files serves the upload page", async () => {
    const res = await fetch(`${base}/files`);
    assert.equal(res.status, 200);
    const html = await res.text();
    for (const id of ["file-input", "file-upload-submit", "file-list", "file-error"]) {
      assert.equal(html.includes(`data-testid="${id}"`), true, id);
    }
    assert.equal(html.includes('dataset.testid = "file-row"'), true);
  });

  test("uploads png, lists it, downloads the bytes, and deletes it", async () => {
    const created = await upload(base, PNG, "image/png", "sample.png");
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.name, "sample.png");
    assert.equal(body.type, "image/png");
    assert.equal(body.size, PNG.length);
    assert.equal(body.url, `/api/files/${body.id}/content`);

    const listed = await fetch(`${base}/api/files`);
    assert.equal(listed.status, 200);
    const list = await listed.json();
    assert.deepEqual(
      list.files.find((file) => file.id === body.id),
      { id: body.id, name: "sample.png", type: "image/png", size: PNG.length, url: body.url },
    );

    const downloaded = await fetch(`${base}${body.url}`);
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), PNG);

    const removed = await fetch(`${base}/api/files/${body.id}`, { method: "DELETE" });
    assert.equal(removed.status, 204);
    assert.equal(removed.headers.get("content-length"), null);
    const missing = await fetch(`${base}${body.url}`);
    assert.equal(missing.status, 404);
    const after = await (await fetch(`${base}/api/files`)).json();
    assert.equal(after.files.some((file) => file.id === body.id), false);
  });

  test("accepts jpeg and pdf", async () => {
    const jpeg = await upload(base, Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg", "photo.jpg");
    const pdf = await upload(base, Buffer.from("%PDF-1.4\n"), "application/pdf", "note.pdf");
    assert.equal(jpeg.status, 201);
    assert.equal(pdf.status, 201);
    const jpegBody = await jpeg.json();
    const pdfBody = await pdf.json();
    assert.equal(jpegBody.type, "image/jpeg");
    assert.equal(pdfBody.type, "application/pdf");
    assert.equal((await fetch(`${base}/api/files/${jpegBody.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await fetch(`${base}/api/files/${pdfBody.id}`, { method: "DELETE" })).status, 204);
  });

  test("rejects a file over 1 MB with 413 and does not store it", async () => {
    const big = Buffer.alloc(1024 * 1024 + 1, 7);
    const res = await upload(base, big, "image/png", "big.png");
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: "payload_too_large" });
    const list = await (await fetch(`${base}/api/files`)).json();
    assert.equal(list.files.some((file) => file.name === "big.png"), false);
  });

  test("accepts a file of exactly 1 MB", async () => {
    const exact = Buffer.alloc(1024 * 1024, 3);
    const res = await upload(base, exact, "image/png", "exact.png");
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.size, 1024 * 1024);
    assert.equal((await fetch(`${base}/api/files/${body.id}`, { method: "DELETE" })).status, 204);
  });

  test("rejects an unsupported type with 415", async () => {
    const res = await upload(base, Buffer.from("hello"), "text/plain", "notes.txt");
    assert.equal(res.status, 415);
    assert.deepEqual(await res.json(), { error: "unsupported_type" });
    const list = await (await fetch(`${base}/api/files`)).json();
    assert.equal(list.files.some((file) => file.name === "notes.txt"), false);
  });

  test("rejects a body that is not multipart with 400", async () => {
    const json = await fetch(`${base}/api/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    assert.equal(json.status, 400);
    assert.deepEqual(await json.json(), { error: "invalid_multipart" });

    const broken = await fetch(`${base}/api/files`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=----broken" },
      body: "this is not a multipart body",
    });
    assert.equal(broken.status, 400);
    assert.deepEqual(await broken.json(), { error: "invalid_multipart" });
  });

  test("DEMO_FILES_REJECT_VALID=1 turns a legal upload into 500 and stores nothing", async () => {
    const prev = process.env.DEMO_FILES_REJECT_VALID;
    process.env.DEMO_FILES_REJECT_VALID = "1";
    try {
      const res = await upload(base, PNG, "image/png", "rejected.png");
      assert.equal(res.status, 500);
      const list = await (await fetch(`${base}/api/files`)).json();
      assert.equal(list.files.some((file) => file.name === "rejected.png"), false);
    } finally {
      if (prev === undefined) delete process.env.DEMO_FILES_REJECT_VALID;
      else process.env.DEMO_FILES_REJECT_VALID = prev;
    }
  });

  test("DEMO_FILES_ACCEPT_INVALID=1 stores an otherwise rejected type", async () => {
    const prev = process.env.DEMO_FILES_ACCEPT_INVALID;
    process.env.DEMO_FILES_ACCEPT_INVALID = "1";
    try {
      const res = await upload(base, Buffer.from("not-an-image"), "text/plain", "forced.txt");
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.name, "forced.txt");
      assert.equal(body.type, "text/plain");
      assert.equal((await fetch(`${base}/api/files/${body.id}`, { method: "DELETE" })).status, 204);
    } finally {
      if (prev === undefined) delete process.env.DEMO_FILES_ACCEPT_INVALID;
      else process.env.DEMO_FILES_ACCEPT_INVALID = prev;
    }
    const again = await upload(base, Buffer.from("not-an-image"), "text/plain", "forced-off.txt");
    assert.equal(again.status, 415);
  });
});

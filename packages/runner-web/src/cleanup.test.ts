import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import test from "node:test";
import type { TestIR } from "@testpilot/test-ir";
import { runTestIR } from "./run.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

type RecordStore = {
  records: Map<string, string>;
  deleteCalls: number;
  failDelete: boolean;
};

function createRecordServer(store: RecordStore): Server {
  return createServer((req, res) => {
    void (async () => {
      if (req.method === "POST" && req.url === "/api/records") {
        const body = JSON.parse(await readBody(req)) as { label: string };
        const id = `rec-${store.records.size + 1}`;
        store.records.set(id, body.label);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id }));
        return;
      }
      if (req.method === "DELETE" && req.url?.startsWith("/api/records/")) {
        store.deleteCalls += 1;
        const id = req.url.slice("/api/records/".length);
        if (store.failDelete) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "delete failed" }));
          return;
        }
        store.records.delete(id);
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET" && req.url === "/api/records") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([...store.records.keys()]));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><body>ok</body>");
    })();
  });
}

function cleanupIr(baseUrl: string, overrides: Partial<TestIR> = {}): TestIR {
  return {
    id: "cleanup-lifecycle",
    version: 1,
    platform: "web",
    baseUrl,
    policy: { cleanup: "always" },
    steps: [
      { id: "open", action: "navigate", path: "/" },
      {
        id: "create",
        action: "request",
        method: "POST",
        path: "/api/records",
        body: { label: "run-{{runId}}" },
        saveFields: { recordId: "id" },
      },
    ],
    teardownSteps: [
      {
        id: "delete-record",
        action: "request",
        method: "DELETE",
        path: "/api/records/{{recordId}}",
      },
    ],
    assertions: [
      {
        id: "created",
        type: "api",
        stepRef: "create",
        expect: { statusCode: 201 },
        oracle: "human-approved",
      },
    ],
    ...overrides,
  };
}

test("always cleanup deletes created record after a passing run", async () => {
  const store: RecordStore = { records: new Map(), deleteCalls: 0, failDelete: false };
  const server = createRecordServer(store);
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(cleanupIr(baseUrl), { env: { baseUrl }, headless: true, runId: "cleanup-pass" });
    assert.equal(run.status, "passed", run.cleanup?.message);
    assert.equal(run.cleanup?.status, "passed");
    assert.equal(store.records.size, 0);
    assert.equal(store.deleteCalls, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("always cleanup runs when product assertion fails", async () => {
  const store: RecordStore = { records: new Map(), deleteCalls: 0, failDelete: false };
  const server = createRecordServer(store);
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(
      cleanupIr(baseUrl, {
        assertions: [
          {
            id: "wrong",
            type: "api",
            stepRef: "create",
            expect: { statusCode: 404 },
            oracle: "human-approved",
          },
        ],
      }),
      { env: { baseUrl }, headless: true },
    );
    assert.equal(run.status, "failed");
    assert.equal(run.metrics.failureKind, "PRODUCT_DEFECT");
    assert.equal(run.cleanup?.status, "passed");
    assert.equal(store.records.size, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("cleanup HTTP 500 fails the run with TEST_DATA when primary passed", async () => {
  const store: RecordStore = { records: new Map(), deleteCalls: 0, failDelete: true };
  const server = createRecordServer(store);
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(cleanupIr(baseUrl), { env: { baseUrl }, headless: true });
    assert.equal(run.status, "failed");
    assert.equal(run.metrics.failureKind, "TEST_DATA");
    assert.equal(run.cleanup?.status, "failed");
    assert.match(run.cleanup?.message ?? "", /cleanup failed/i);
    assert.equal(store.records.size, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("PRODUCT_DEFECT is not masked when cleanup also fails", async () => {
  const store: RecordStore = { records: new Map(), deleteCalls: 0, failDelete: true };
  const server = createRecordServer(store);
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(
      cleanupIr(baseUrl, {
        assertions: [
          {
            id: "wrong",
            type: "api",
            stepRef: "create",
            expect: { statusCode: 400 },
            oracle: "human-approved",
          },
        ],
      }),
      { env: { baseUrl }, headless: true },
    );
    assert.equal(run.status, "failed");
    assert.equal(run.metrics.failureKind, "PRODUCT_DEFECT");
    assert.equal(run.cleanup?.status, "failed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("policy none skips cleanup and does not DELETE", async () => {
  const store: RecordStore = { records: new Map(), deleteCalls: 0, failDelete: false };
  const server = createRecordServer(store);
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(
      cleanupIr(baseUrl, { policy: { cleanup: "none" }, teardownSteps: undefined }),
      { env: { baseUrl }, headless: true },
    );
    assert.equal(run.status, "passed");
    assert.equal(run.cleanup?.status, "skipped");
    assert.equal(store.deleteCalls, 0);
    assert.equal(store.records.size, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("on-success skips cleanup when primary failed", async () => {
  const store: RecordStore = { records: new Map(), deleteCalls: 0, failDelete: false };
  const server = createRecordServer(store);
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const run = await runTestIR(
      cleanupIr(baseUrl, {
        policy: { cleanup: "on-success" },
        assertions: [
          {
            id: "wrong",
            type: "api",
            stepRef: "create",
            expect: { statusCode: 500 },
            oracle: "human-approved",
          },
        ],
      }),
      { env: { baseUrl }, headless: true },
    );
    assert.equal(run.status, "failed");
    assert.equal(run.cleanup?.status, "skipped");
    assert.match(run.cleanup?.message ?? "", /on-success/i);
    assert.equal(store.deleteCalls, 0);
    assert.equal(store.records.size, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

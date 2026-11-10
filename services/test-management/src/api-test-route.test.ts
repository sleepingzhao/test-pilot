import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { registerRoutes } from "./routes.js";
import { FileStore } from "./store.js";

test("POST /api/api-tests with cleanup saves teardown and policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-api-test-"));
  const store = new FileStore(join(root, "data"));
  await store.init();
  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, join(root, "artifacts"), join(root, "data"));
  await app.ready();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/api-tests",
      payload: {
        title: "条目+清理",
        target: "custom",
        customUrl: "http://127.0.0.1:9",
        method: "POST",
        path: "/api/items",
        body: { name: "x-{{runId}}" },
        expectStatus: 201,
        cleanup: { path: "/api/items/{{createdId}}" },
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      test: { ir: { teardownSteps?: unknown[]; policy?: { cleanup?: string } } };
      warnings?: string[];
      trialError?: string;
    };
    assert.match(String(body.trialError), /不可达/);
    assert.equal(body.test.ir.policy?.cleanup, "always");
    assert.equal(body.test.ir.teardownSteps?.length, 1);
    assert.deepEqual((body.test.ir.teardownSteps?.[0] as { id: string }).id, "cleanup");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("POST /api/api-tests saves a draft and reports an unreachable target", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-api-test-"));
  const store = new FileStore(join(root, "data"));
  await store.init();
  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, join(root, "artifacts"), join(root, "data"));
  await app.ready();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/api-tests",
      payload: {
        title: "健康检查",
        target: "custom",
        customUrl: "http://127.0.0.1:9",
        method: "GET",
        path: "/api/health",
        expectStatus: 200,
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      test: { id: string; approvalStatus: string; sourceChannel: string; ir: { assertions: unknown[] } };
      trialError?: string;
    };
    assert.equal(body.test.approvalStatus, "draft");
    assert.equal(body.test.sourceChannel, "api");
    assert.match(body.test.id, /^api-/);
    assert.match(String(body.trialError), /不可达/);
    const stored = await store.getTest(body.test.id);
    assert.equal(stored?.approvalStatus, "draft");
    assert.equal(stored?.ir.baseUrl, "http://127.0.0.1:9");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("POST /api/api-tests rejects pilot, unsafe headers, and bad status (negative)", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-api-test-"));
  const store = new FileStore(join(root, "data"));
  await store.init();
  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, join(root, "artifacts"), join(root, "data"));
  await app.ready();
  try {
    const pilot = await app.inject({
      method: "POST",
      url: "/api/api-tests",
      payload: { target: "pilot", method: "GET", path: "/api/x" },
    });
    assert.equal(pilot.statusCode, 400);
    assert.match(pilot.body, /授权/);

    const header = await app.inject({
      method: "POST",
      url: "/api/api-tests",
      payload: {
        target: "demo",
        method: "GET",
        path: "/api/x",
        headers: { host: "evil.example" },
      },
    });
    assert.equal(header.statusCode, 400);
    assert.match(header.body, /不允许手动设置/);

    const status = await app.inject({
      method: "POST",
      url: "/api/api-tests",
      payload: { target: "demo", method: "GET", path: "/api/x", expectStatus: 99 },
    });
    assert.equal(status.statusCode, 400);
    assert.match(status.body, /状态码/);

    assert.equal((await store.listTests()).length, 0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

const API_ENVS_ENV = "TESTPILOT_API_ENVS_FILE";

async function writeApiEnvs(root: string, entries: unknown[]): Promise<string> {
  const file = join(root, "api-envs.json");
  await writeFile(file, JSON.stringify(entries), "utf8");
  return file;
}

test("GET /api/api-envs exposes names only", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-api-envs-route-"));
  const prev = process.env[API_ENVS_ENV];
  process.env[API_ENVS_ENV] = await writeApiEnvs(root, [
    {
      id: "local-ro",
      label: "Local read-only",
      baseUrl: "http://127.0.0.1:4173",
      headers: { Authorization: "Bearer {{env.stagingToken}}" },
      allowWrite: false,
    },
  ]);
  const store = new FileStore(join(root, "data"));
  await store.init();
  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, join(root, "artifacts"), join(root, "data"));
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/api/api-envs" });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { envs: Array<Record<string, unknown>> };
    assert.equal(body.envs.length, 1);
    assert.deepEqual(body.envs[0]?.headerNames, ["Authorization"]);
    assert.equal(body.envs[0]?.headers, undefined);
    assert.equal(JSON.stringify(body).includes("Bearer"), false);
  } finally {
    await app.close();
    if (prev === undefined) delete process.env[API_ENVS_ENV];
    else process.env[API_ENVS_ENV] = prev;
    await rm(root, { recursive: true, force: true });
  }
});

test("POST /api/api-tests resolves envId, merges headers, and enforces allowWrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-api-envs-route-"));
  const prev = process.env[API_ENVS_ENV];
  process.env[API_ENVS_ENV] = await writeApiEnvs(root, [
    {
      id: "local-ro",
      label: "Local read-only",
      baseUrl: "http://127.0.0.1:9",
      headers: { Authorization: "Bearer {{env.roToken}}", "X-Env": "from-config" },
      allowWrite: false,
    },
    {
      id: "local-rw",
      label: "Local writable",
      baseUrl: "http://127.0.0.1:9",
      headers: { Authorization: "Bearer {{env.rwToken}}" },
      allowWrite: true,
    },
  ]);
  const store = new FileStore(join(root, "data"));
  await store.init();
  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, join(root, "artifacts"), join(root, "data"));
  await app.ready();
  try {
    const unknown = await app.inject({
      method: "POST",
      url: "/api/api-tests",
      payload: { envId: "missing", method: "GET", path: "/api/x" },
    });
    assert.equal(unknown.statusCode, 400);
    assert.match(unknown.body, /未知/);

    const writeBlocked = await app.inject({
      method: "POST",
      url: "/api/api-tests",
      payload: { envId: "local-ro", method: "POST", path: "/api/items" },
    });
    assert.equal(writeBlocked.statusCode, 400);
    assert.match(writeBlocked.body, /只读/);

    const getOk = await app.inject({
      method: "POST",
      url: "/api/api-tests",
      payload: {
        envId: "local-ro",
        method: "GET",
        path: "/api/health",
        headers: { authorization: "Bearer override" },
      },
    });
    assert.equal(getOk.statusCode, 200, getOk.body);
    const getBody = getOk.json() as {
      test: { ir: { baseUrl: string; steps: Array<{ headers?: Record<string, string> }> } };
    };
    assert.equal(getBody.test.ir.baseUrl, "http://127.0.0.1:9");
    const stepHeaders = getBody.test.ir.steps[0]?.headers ?? {};
    assert.equal(stepHeaders.authorization, "Bearer override");
    assert.equal(stepHeaders["X-Env"], "from-config");
    assert.equal(stepHeaders.Authorization, undefined);

    const postAllowed = await app.inject({
      method: "POST",
      url: "/api/api-tests",
      payload: {
        envId: "local-rw",
        method: "POST",
        path: "/api/items",
        body: { name: "x" },
      },
    });
    assert.equal(postAllowed.statusCode, 200, postAllowed.body);
  } finally {
    await app.close();
    if (prev === undefined) delete process.env[API_ENVS_ENV];
    else process.env[API_ENVS_ENV] = prev;
    await rm(root, { recursive: true, force: true });
  }
});

test("custom URL cannot bypass the pilot/real read-only guard (negative)", async () => {
  const keys = [
    "TESTPILOT_REAL_BASE_URL",
    "TESTPILOT_PILOT_BASE_URL",
    "TESTPILOT_ALLOWED_TARGETS",
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.TESTPILOT_REAL_BASE_URL = "https://real.example";
  process.env.TESTPILOT_PILOT_BASE_URL = "https://pilot.example";
  process.env.TESTPILOT_ALLOWED_TARGETS = "real.example,pilot.example";

  const root = await mkdtemp(join(tmpdir(), "testpilot-api-test-"));
  const store = new FileStore(join(root, "data"));
  await store.init();
  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, join(root, "artifacts"), join(root, "data"));
  await app.ready();
  try {
    for (const customUrl of ["https://real.example", "https://pilot.example"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/api-tests",
        payload: { target: "custom", customUrl, method: "GET", path: "/api/x" },
      });
      assert.equal(res.statusCode, 400, `${customUrl}: ${res.body}`);
    }
    assert.equal((await store.listTests()).length, 0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

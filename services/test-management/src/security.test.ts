import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { registerRoutes } from "./routes.js";
import {
  isAllowedCorsOrigin,
  isAllowedTargetUrl,
  isSafeArtifactName,
  isSafeRunId,
  isSafeTestId,
  isWithin,
  isLoopbackHost,
  registerSecurity,
  resolveWithin,
} from "./security.js";
import { FileStore, type StoredRun } from "./store.js";

test("storage ids reject traversal and uppercase", () => {
  assert.equal(isSafeTestId("demo-users-smoke"), true);
  assert.equal(isSafeTestId("../demo"), false);
  assert.equal(isSafeTestId("Demo"), false);
  assert.equal(isSafeTestId("a_b"), false);
  assert.equal(isSafeRunId("run_1793732240740"), true);
  assert.equal(isSafeRunId("run_1_r2"), true);
  assert.equal(isSafeRunId("../../x"), false);
  assert.equal(isSafeArtifactName("trace.zip"), true);
  assert.equal(isSafeArtifactName("network.json"), true);
  assert.equal(isSafeArtifactName("../trace.zip"), false);
  assert.equal(isSafeArtifactName(".env"), false);
});

test("path containment rejects sibling-prefix and parent escapes", () => {
  assert.equal(isWithin("/a/b", "/a/b/c"), true);
  assert.equal(isWithin("/a/b", "/a/bc"), false);
  assert.equal(resolveWithin("/a/b", "c/d"), "/a/b/c/d");
  assert.equal(resolveWithin("/a/b", "../c"), null);
  assert.equal(resolveWithin("/a/b", "/etc/passwd"), null);
});

test("target allow-list blocks metadata, file, userinfo, and unknown hosts", () => {
  const previousPilot = process.env.TESTPILOT_PILOT_BASE_URL;
  const previousTargets = process.env.TESTPILOT_ALLOWED_TARGETS;
  process.env.TESTPILOT_PILOT_BASE_URL = "https://pilot.example.com";
  process.env.TESTPILOT_ALLOWED_TARGETS = "https://staging.example.com/";
  try {
    assert.equal(isAllowedTargetUrl("http://127.0.0.1:4173/"), true);
    assert.equal(isAllowedTargetUrl("http://localhost:4173/"), true);
    assert.equal(isAllowedTargetUrl("https://pilot.example.com/admin"), true);
    assert.equal(isAllowedTargetUrl("https://staging.example.com/app"), true);
    assert.equal(isAllowedTargetUrl("https://evil.example.com"), false);
    assert.equal(isAllowedTargetUrl("http://127.0.0.1.evil.com"), false);
    assert.equal(isLoopbackHost("127.0.0.1.evil.com"), false);
    assert.equal(isAllowedTargetUrl("http://169.254.169.254/latest/meta-data"), false);
    assert.equal(isAllowedTargetUrl("file:///etc/passwd"), false);
    assert.equal(isAllowedTargetUrl("https://user:pass@pilot.example.com"), false);
  } finally {
    if (previousPilot === undefined) delete process.env.TESTPILOT_PILOT_BASE_URL;
    else process.env.TESTPILOT_PILOT_BASE_URL = previousPilot;
    if (previousTargets === undefined) delete process.env.TESTPILOT_ALLOWED_TARGETS;
    else process.env.TESTPILOT_ALLOWED_TARGETS = previousTargets;
  }
});

test("CORS allow-list is local-only unless configured", () => {
  const previous = process.env.TESTPILOT_ALLOWED_ORIGINS;
  delete process.env.TESTPILOT_ALLOWED_ORIGINS;
  try {
    assert.equal(isAllowedCorsOrigin(undefined), true);
    assert.equal(isAllowedCorsOrigin("http://127.0.0.1:5173"), true);
    assert.equal(isAllowedCorsOrigin("http://localhost:5173"), true);
    assert.equal(isAllowedCorsOrigin("https://evil.example"), false);
    process.env.TESTPILOT_ALLOWED_ORIGINS = "https://console.example/";
    assert.equal(isAllowedCorsOrigin("https://console.example"), true);
  } finally {
    if (previous === undefined) delete process.env.TESTPILOT_ALLOWED_ORIGINS;
    else process.env.TESTPILOT_ALLOWED_ORIGINS = previous;
  }
});

test("security hooks block cross-origin writes and enforce optional token", async () => {
  const previousToken = process.env.TESTPILOT_API_TOKEN;
  delete process.env.TESTPILOT_API_TOKEN;
  const app = Fastify();
  registerSecurity(app);
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/projects", async () => ({ ok: true }));
  app.post("/api/action", async () => ({ ok: true }));
  await app.ready();
  try {
    const blocked = await app.inject({
      method: "POST",
      url: "/api/action",
      headers: { origin: "https://evil.example" },
    });
    assert.equal(blocked.statusCode, 403);

    const allowed = await app.inject({
      method: "POST",
      url: "/api/action",
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(allowed.statusCode, 200);

    const noOrigin = await app.inject({ method: "POST", url: "/api/action" });
    assert.equal(noOrigin.statusCode, 200);

    process.env.TESTPILOT_API_TOKEN = "s3cret";
    const unauthorized = await app.inject({ method: "GET", url: "/api/projects" });
    assert.equal(unauthorized.statusCode, 401);

    const health = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.statusCode, 200);

    const withHeader = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { "x-testpilot-token": "s3cret" },
    });
    assert.equal(withHeader.statusCode, 200);

    const withBearer = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: "Bearer s3cret" },
    });
    assert.equal(withBearer.statusCode, 200);
  } finally {
    if (previousToken === undefined) delete process.env.TESTPILOT_API_TOKEN;
    else process.env.TESTPILOT_API_TOKEN = previousToken;
    await app.close();
  }
});

function makeRun(runId: string, dir: string): StoredRun {
  return {
    runId,
    testId: "demo-users-smoke",
    testTitle: "demo",
    testVersion: 1,
    projectId: "default",
    status: "passed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    steps: [],
    assertions: [],
    artifacts: {
      runId,
      dir,
      artifacts: [
        { kind: "trace", path: join(dir, "trace.zip") },
        { kind: "network", path: join(dir, "network.json") },
      ],
    },
    metrics: { durationMs: 1, llmTokensUsed: 0, attemptCount: 1 },
  };
}

test("artifact routes cannot escape the run directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-security-"));
  const artifactsRoot = join(root, "artifacts");
  const dataRoot = join(root, "data");
  const runDir = join(artifactsRoot, "runs", "run_sec1");
  const store = new FileStore(dataRoot);
  await store.init();
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "trace.zip"), "zipdata");
  await writeFile(join(runDir, "network.json"), "[]\n");
  await writeFile(join(root, ".env"), "SECRET=topsecret\n");
  await store.saveRun(makeRun("run_sec1", runDir));

  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, artifactsRoot, dataRoot);
  await app.ready();
  try {
    const trace = await app.inject({ method: "GET", url: "/api/runs/run_sec1/artifacts/trace.zip" });
    assert.equal(trace.statusCode, 200);
    assert.equal(trace.body, "zipdata");

    const network = await app.inject({ method: "GET", url: "/api/runs/run_sec1/artifacts/network.json" });
    assert.equal(network.statusCode, 200);

    const encoded = await app.inject({
      method: "GET",
      url: "/api/runs/run_sec1/artifacts/%2e%2e%2f%2e%2e%2f%2e%2e%2f.env",
    });
    assert.equal(encoded.statusCode, 404);

    const raw = await app.inject({
      method: "GET",
      url: "/api/runs/run_sec1/artifacts/../../../.env",
    });
    assert.equal(raw.statusCode, 404);

    const badRunId = await app.inject({
      method: "GET",
      url: "/api/runs/%2e%2e%2f%2e%2e%2fetc%2fpasswd/artifacts/manifest.json",
    });
    assert.equal(badRunId.statusCode, 404);

    const unregistered = await app.inject({
      method: "GET",
      url: "/api/runs/run_sec1/artifacts/manifest.json",
    });
    assert.equal(unregistered.statusCode, 404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

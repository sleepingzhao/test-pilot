import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import test from "node:test";
import type { TestIR } from "@testpilot/test-ir";
import { runTestIR } from "./run.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

function miniPageIr(
  baseUrl: string,
  screenshots: "always" | "on-failure" | "never",
): TestIR {
  return {
    id: "step-shots",
    version: 1,
    platform: "web",
    baseUrl,
    policy: { screenshots },
    steps: [
      { id: "open", action: "navigate", path: "/" },
      { id: "wait-done", action: "wait" },
    ],
    assertions: [],
  };
}

function failingIr(baseUrl: string): TestIR {
  return {
    id: "step-shots-fail",
    version: 1,
    platform: "web",
    baseUrl,
    policy: { screenshots: "always" },
    steps: [
      { id: "open", action: "navigate", path: "/" },
      {
        id: "bad-click",
        action: "click",
        target: { css: "#definitely-missing-step-shot-target" },
      },
    ],
    assertions: [],
  };
}

test("screenshots always captures each passed step", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><body><h1>shots</h1></body>");
  });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const artifactsDir = await mkdtemp(join(tmpdir(), "testpilot-step-shots-always-"));
  const runId = "shots-always-pass";
  try {
    const run = await runTestIR(miniPageIr(baseUrl, "always"), {
      env: { baseUrl },
      headless: true,
      runId,
      artifactsDir,
    });
    assert.equal(run.status, "passed");
    assert.equal(run.steps.length, 2);
    for (const step of run.steps) {
      assert.ok(step.screenshot, step.stepId);
      assert.match(step.screenshot!, /^step-\d{2}-.+\.png$/);
      assert.ok(!step.screenshot!.includes("/"));
    }
    const runDir = join(artifactsDir, runId);
    const names = await readdir(runDir);
    const stepPngs = names.filter((n) => n.startsWith("step-") && n.endsWith(".png"));
    assert.equal(stepPngs.length, 2);

    const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as {
      stepScreenshots: Array<{ stepId: string; file: string }>;
    };
    assert.equal(manifest.stepScreenshots.length, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

test("screenshots on-failure does not capture per-step images on pass", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><body>ok</body>");
  });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const artifactsDir = await mkdtemp(join(tmpdir(), "testpilot-step-shots-onfail-"));
  const runId = "shots-onfailure-pass";
  try {
    const run = await runTestIR(miniPageIr(baseUrl, "on-failure"), {
      env: { baseUrl },
      headless: true,
      runId,
      artifactsDir,
    });
    assert.equal(run.status, "passed");
    for (const step of run.steps) {
      assert.equal(step.screenshot, undefined);
    }
    const names = await readdir(join(artifactsDir, runId));
    const stepPngs = names.filter((n) => n.startsWith("step-") && n.endsWith(".png"));
    assert.equal(stepPngs.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

test("failed step has no step screenshot; failure screenshot remains", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><body>ok</body>");
  });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const artifactsDir = await mkdtemp(join(tmpdir(), "testpilot-step-shots-fail-"));
  const runId = "shots-always-fail";
  try {
    const run = await runTestIR(failingIr(baseUrl), {
      env: { baseUrl },
      headless: true,
      runId,
      artifactsDir,
    });
    assert.equal(run.status, "failed");
    assert.equal(run.steps[0]?.status, "passed");
    assert.ok(run.steps[0]?.screenshot);
    assert.equal(run.steps[1]?.status, "failed");
    assert.equal(run.steps[1]?.screenshot, undefined);
    const names = await readdir(join(artifactsDir, runId));
    assert.ok(names.some((n) => n.startsWith("failure-bad-click")));
    const stepPngs = names.filter((n) => n.startsWith("step-") && n.endsWith(".png"));
    assert.equal(stepPngs.length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

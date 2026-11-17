import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { waitForHttpReady, type RunEnvironment } from "@testpilot/fixtures";
import type { TestIR } from "@testpilot/test-ir";
import { runTestIR } from "./run.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const demoDir = join(root, "examples/demo-webapp");

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

async function startDemo(): Promise<{ baseUrl: string; stop: () => void }> {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const demo: ChildProcess = spawn("node", ["server.mjs"], {
    cwd: demoDir,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  try {
    await waitForHttpReady(`${baseUrl}/sse`);
  } catch (err) {
    demo.kill("SIGTERM");
    throw err;
  }
  return { baseUrl, stop: () => demo.kill("SIGTERM") };
}

function sseIr(): TestIR {
  return {
    id: "demo-sse-pipeline",
    version: 1,
    platform: "web",
    steps: [
      { id: "open-sse", action: "navigate", path: "/sse" },
      { id: "start-sse", action: "click", target: { testId: "sse-start" } },
      { id: "wait-done", action: "wait" },
    ],
    assertions: [
      {
        id: "sse-status",
        type: "ui",
        target: { testId: "sse-status" },
        contains: "完成",
        oracle: "human-approved",
      },
      {
        id: "sse-list",
        type: "ui",
        target: { testId: "sse-list" },
        contains: "测试sse-3",
        oracle: "human-approved",
      },
    ],
    policy: { screenshots: "never" },
  };
}

test("sse page run captures sse.json with three data events and done", async () => {
  const demo = await startDemo();
  const artifactsDir = await mkdtemp(join(tmpdir(), "tp-sse-pipeline-"));
  const env: RunEnvironment = { baseUrl: demo.baseUrl };
  const runId = "sse-pipeline-ok";
  try {
    const result = await runTestIR(sseIr(), { env, headless: true, artifactsDir, runId });
    assert.equal(result.status, "passed", JSON.stringify({ steps: result.steps, assertions: result.assertions }));
    assert.ok(result.artifacts.artifacts.some((item) => item.kind === "sse"));
    const written = JSON.parse(await readFile(join(artifactsDir, runId, "sse.json"), "utf8")) as {
      events: Array<{ event?: string; data: string }>;
    };
    assert.equal(written.events.filter((e) => e.data.includes("测试sse")).length, 3);
    assert.equal(written.events.some((e) => e.event === "done"), true);
  } finally {
    demo.stop();
    await rm(artifactsDir, { recursive: true, force: true });
  }
});
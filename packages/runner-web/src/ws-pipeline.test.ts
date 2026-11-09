import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { waitForHttpReady, type RunEnvironment } from "@testpilot/fixtures";
import type { TestIR } from "@testpilot/test-ir";
import { runTestIR, type RunResult } from "./run.js";

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
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
  delete env.DEMO_CHAT_DROP;
  const demo: ChildProcess = spawn("node", ["server.mjs"], { cwd: demoDir, env, stdio: "ignore" });
  try {
    await waitForHttpReady(`${baseUrl}/chat`);
  } catch (err) {
    demo.kill("SIGTERM");
    throw err;
  }
  return { baseUrl, stop: () => demo.kill("SIGTERM") };
}

function chatIr(path: string, text: string): TestIR {
  return {
    id: "demo-chat-pipeline",
    version: 1,
    platform: "web",
    steps: [
      { id: "open-chat", action: "navigate", path },
      { id: "wait-status", action: "wait", target: { testId: "chat-status" } },
      { id: "fill-message", action: "fill", target: { testId: "chat-composer" }, value: text },
      { id: "send-message", action: "click", target: { testId: "chat-send" } },
    ],
    assertions: [
      {
        id: "ws-sent",
        type: "event",
        provider: "ws",
        expect: { direction: "sent", contains: text, urlIncludes: "/ws/chat", timeoutMs: 3000 },
        oracle: "human-approved",
      },
      {
        id: "ws-received",
        type: "event",
        provider: "ws",
        expect: { direction: "received", contains: text, urlIncludes: "/ws/chat", timeoutMs: 3000 },
        oracle: "human-approved",
      },
      {
        id: "chat-list",
        type: "ui",
        target: { testId: "chat-list" },
        contains: text,
        oracle: "human-approved",
      },
    ],
    policy: { screenshots: "never" },
  };
}

test("chat send captures the outbound frame, the broadcast, and the list", async () => {
  const demo = await startDemo();
  const artifactsDir = await mkdtemp(join(tmpdir(), "tp-ws-pipeline-"));
  const text = `pipeline-hello-${Date.now()}`;
  const env: RunEnvironment = { baseUrl: demo.baseUrl };
  try {
    const result = await runTestIR(chatIr("/chat", text), {
      env,
      headless: true,
      artifactsDir,
      runId: "ws-pipeline-ok",
    });
    assert.equal(result.status, "passed", JSON.stringify({ steps: result.steps, assertions: result.assertions }));
    assert.equal(result.assertions.every((item) => item.passed), true);
  } finally {
    demo.stop();
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

test("chat?drop=1 fails the received frame assertion as a product defect", async () => {
  const demo = await startDemo();
  const artifactsDir = await mkdtemp(join(tmpdir(), "tp-ws-pipeline-drop-"));
  const text = `pipeline-drop-${Date.now()}`;
  const env: RunEnvironment = { baseUrl: demo.baseUrl };
  try {
    const result = await runTestIR(chatIr("/chat?drop=1", text), {
      env,
      headless: true,
      artifactsDir,
      runId: "ws-pipeline-drop",
    });
    assert.equal(result.steps.every((step) => step.status === "passed"), true, JSON.stringify(result.steps));
    assert.equal(result.assertions.find((item) => item.assertionId === "ws-sent")?.passed, true);
    assertProductDefect(result, "ws-received");
    assert.equal(result.assertions.find((item) => item.assertionId === "chat-list")?.passed, false);
    assert.equal(result.assertions.find((item) => item.assertionId === "chat-list")?.errorKind, "PRODUCT_DEFECT");
  } finally {
    demo.stop();
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

function assertProductDefect(run: RunResult, assertionId: string) {
  assert.equal(run.status, "failed", JSON.stringify({ steps: run.steps, assertions: run.assertions }));
  const assertion = run.assertions.find((item) => item.assertionId === assertionId);
  assert.equal(assertion?.passed, false);
  assert.equal(assertion?.errorKind, "PRODUCT_DEFECT");
  assert.equal(run.metrics.failureKind, "PRODUCT_DEFECT");
  assert.match(assertion?.message ?? "", /websocket assertion failed/);
}

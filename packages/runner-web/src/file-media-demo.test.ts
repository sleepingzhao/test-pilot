import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";
import { waitForHttpReady, type RunEnvironment } from "@testpilot/fixtures";
import { planFileMedia, type FileMediaScenario } from "@testpilot/mechanisms";
import { runTestIR, type RunResult } from "./run.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const demoDir = join(root, "examples/demo-webapp");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const plan = planFileMedia(
  { capabilities: [{ id: "file-media", confidence: 0.9 }] },
  {
    uploadRef: "fixture.samplePng",
    fileName: "pixel.png",
    uploadRequestRef: "files-upload",
    invalidTypeRef: "fixture.sampleTxt",
    invalidTypeName: "notes.txt",
  },
);

function scenario(kind: FileMediaScenario["kind"]): FileMediaScenario {
  const found = plan.scenarios.find((item) => item.kind === kind);
  if (!found) throw new Error(`missing ${kind} scenario`);
  return found;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

async function startDemo(flags: Record<string, string> = {}): Promise<{ baseUrl: string; stop: () => void }> {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
  delete env.DEMO_FILES_REJECT_VALID;
  delete env.DEMO_FILES_ACCEPT_INVALID;
  for (const [key, value] of Object.entries(flags)) env[key] = value;
  const demo: ChildProcess = spawn("node", ["server.mjs"], {
    cwd: demoDir,
    env,
    stdio: "ignore",
  });
  try {
    await waitForHttpReady(`${baseUrl}/files`);
  } catch (err) {
    demo.kill("SIGTERM");
    throw err;
  }
  return { baseUrl, stop: () => demo.kill("SIGTERM") };
}

describe("file-media demo faults", { concurrency: 1 }, () => {
  let fixtureDir = "";
  let artifactsDir = "";

  test.before(async () => {
    const parent = await mkdtemp(join(tmpdir(), "tp-file-media-"));
    fixtureDir = join(parent, "fixtures");
    artifactsDir = join(parent, "artifacts");
    await mkdir(fixtureDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(fixtureDir, "pixel.png"), PNG);
    await writeFile(join(fixtureDir, "notes.txt"), "not-an-image");
    assert.equal(plan.runnable, true);
  });

  test.after(async () => {
    if (fixtureDir) await rm(join(fixtureDir, ".."), { recursive: true, force: true });
  });

  function envFor(baseUrl: string): RunEnvironment {
    return {
      baseUrl,
      fixtureDir,
      fixtureValues: {
        "fixture.samplePng": "pixel.png",
        "fixture.sampleTxt": "notes.txt",
      },
      requestRefs: { "files-upload": { urlIncludes: "/api/files", method: "POST" } },
    };
  }

  test("happy upload is listed and the API returns 201", async () => {
    const demo = await startDemo();
    try {
      const result = await runTestIR(
        { ...scenario("happy").ir, baseUrl: demo.baseUrl },
        { env: envFor(demo.baseUrl), headless: true, artifactsDir, runId: "file-media-happy" },
      );
      assert.equal(result.status, "passed", JSON.stringify({ steps: result.steps, assertions: result.assertions }));
      assert.equal(result.assertions.every((item) => item.passed), true);
    } finally {
      demo.stop();
    }
  });

  test("DEMO_FILES_REJECT_VALID=1 fails the happy scenario as a product defect", async () => {
    const demo = await startDemo({ DEMO_FILES_REJECT_VALID: "1" });
    try {
      const result = await runTestIR(
        { ...scenario("happy").ir, baseUrl: demo.baseUrl },
        { env: envFor(demo.baseUrl), headless: true, artifactsDir, runId: "file-media-reject" },
      );
      assertProductDefect(result, "upload-created", /status 201/);
      assert.equal(result.steps.every((step) => step.status === "passed"), true);
    } finally {
      demo.stop();
    }
  });

  test("DEMO_FILES_ACCEPT_INVALID=1 fails the invalid-type scenario", async () => {
    const demo = await startDemo({ DEMO_FILES_ACCEPT_INVALID: "1" });
    try {
      const result = await runTestIR(
        { ...scenario("invalid-type").ir, baseUrl: demo.baseUrl },
        { env: envFor(demo.baseUrl), headless: true, artifactsDir, runId: "file-media-accept" },
      );
      assertProductDefect(result, "upload-rejected-type", /status 415/);
      assert.equal(result.steps.every((step) => step.status === "passed"), true);
    } finally {
      demo.stop();
    }
  });
});

function assertProductDefect(run: RunResult, assertionId: string, message: RegExp) {
  assert.equal(run.status, "failed", JSON.stringify({ steps: run.steps, assertions: run.assertions }));
  const assertion = run.assertions.find((item) => item.assertionId === assertionId);
  assert.equal(assertion?.passed, false);
  assert.equal(assertion?.errorKind, "PRODUCT_DEFECT");
  assert.equal(run.metrics.failureKind, "PRODUCT_DEFECT");
  assert.match(assertion?.message ?? "", message);
}

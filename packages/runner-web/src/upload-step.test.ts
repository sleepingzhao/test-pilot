import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestIR } from "@testpilot/test-ir";
import { resolveValueRefEnvKey } from "@testpilot/fixtures";
import { runTestIR } from "./run.js";

const SENTINEL = "SENTINEL_DO_NOT_READ_7f3a";

const PAGE = `<!DOCTYPE html>
<html><body>
<input id="file" type="file" data-testid="file-input" />
<p id="chosen">none-selected</p>
<script>
  document.getElementById("file").addEventListener("change", () => {
    const file = document.getElementById("file").files[0];
    document.getElementById("chosen").textContent = file ? "selected:" + file.name : "none-selected";
  });
</script>
</body></html>`;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

function uploadIr(baseUrl: string, valueRef: string, extra?: { value?: string }): TestIR {
  return {
    id: "upload-step",
    version: 1,
    platform: "web",
    baseUrl,
    policy: { screenshots: "never" },
    steps: [
      { id: "open", action: "navigate", path: "/" },
      {
        id: "up",
        action: "upload",
        target: { testId: "file-input" },
        valueRef,
        ...(extra?.value !== undefined ? { value: extra.value } : {}),
      },
    ],
    assertions:
      extra?.value !== undefined
        ? []
        : [{ type: "ui", oracle: "human-approved", contains: "selected:sample.txt" }],
  };
}

test("upload step sets a fixture file and refuses paths that would read outside it", async () => {
  const parent = await mkdtemp(join(tmpdir(), "tp-upload-run-"));
  const fixtureDir = join(parent, "fixtures");
  const artifactsDir = join(parent, "artifacts");
  await mkdir(fixtureDir);
  const secret = join(parent, "secret.txt");
  const fifo = join(parent, "blocked.fifo");
  await writeFile(secret, SENTINEL);
  await writeFile(join(fixtureDir, "sample.txt"), "hello-upload");
  await mkdir(join(fixtureDir, "subdir"));
  const made = spawnSync("mkfifo", [fifo]);
  assert.equal(made.status, 0, made.stderr?.toString());
  await symlink(secret, join(fixtureDir, "escape.txt"));
  await symlink(fifo, join(fixtureDir, "escape-fifo.txt"));

  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const envKey = resolveValueRefEnvKey("fixture.sampletxt");
  const prev = process.env[envKey];
  process.env[envKey] = "sample.txt";

  try {
    const ir = uploadIr(baseUrl, "fixture.sampletxt");
    assert.equal(JSON.stringify(ir.steps).includes(fixtureDir), false);
    assert.equal(JSON.stringify(ir.steps).includes(secret), false);
    assert.equal(JSON.stringify(ir.steps).includes("sample.txt"), false);
    assert.equal(JSON.stringify(ir).includes("hello-upload"), false);
    assert.equal(JSON.stringify(ir).includes(SENTINEL), false);

    const passed = await runTestIR(ir, {
      env: { baseUrl, fixtureDir },
      artifactsDir,
      headless: true,
    });
    assert.equal(passed.status, "passed", JSON.stringify(passed.steps));
    assert.equal(passed.steps.every((step) => step.status === "passed"), true);

    async function rejected(valueRef: string, rel: string, pattern: RegExp) {
      const result = await runTestIR(
        {
          ...uploadIr(baseUrl, valueRef),
          assertions: [],
        },
        {
          env: { baseUrl, fixtureDir, fixtureValues: { [valueRef]: rel } },
          artifactsDir,
          headless: true,
        },
      );
      assert.equal(result.status, "failed", JSON.stringify(result));
      assert.equal(result.steps[0]?.status, "passed");
      assert.equal(result.steps[1]?.stepId, "up");
      assert.equal(result.steps[1]?.status, "failed");
      assert.match(result.steps[1]?.message ?? "", pattern);
      assert.equal(JSON.stringify(result).includes(SENTINEL), false);
      assert.equal((result.steps[1]?.message ?? "").includes(secret), false);
      assert.equal((result.steps[1]?.message ?? "").includes(fifo), false);
    }

    const missingRef = "fixture.notconfigured";
    delete process.env[resolveValueRefEnvKey(missingRef)];
    await rejected(missingRef, "", /upload valueRef is not set/);
    await rejected("fixture.dir", "subdir", /not a directory/);
    await rejected("fixture.up", "../secret.txt", /must not contain \.\./);
    await rejected("fixture.abs", secret, /escapes fixture directory/);
    await rejected("fixture.link", "escape.txt", /escapes fixture directory/);
    await rejected("fixture.fifo", "escape-fifo.txt", /escapes fixture directory/);

    const embedded = await runTestIR(uploadIr(baseUrl, "fixture.sampletxt", { value: secret }), {
      env: { baseUrl, fixtureDir },
      artifactsDir,
      headless: true,
    });
    assert.equal(embedded.status, "failed");
    assert.match(embedded.steps[1]?.message ?? "", /must not store a file path in value/);
    assert.equal(JSON.stringify(embedded).includes(SENTINEL), false);
  } finally {
    if (prev === undefined) delete process.env[envKey];
    else process.env[envKey] = prev;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await rm(parent, { recursive: true, force: true });
  }
});

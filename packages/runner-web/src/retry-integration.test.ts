import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runTestIR } from "./run.js";

const policy = { retry: { attempts: 1, on: ["ENVIRONMENT"] } };

test("retries transient environment failures and records both attempts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "testpilot-retry-env-"));
  const run = await runTestIR(
    {
      id: "retry-env",
      version: 1,
      platform: "web",
      steps: [{ id: "open", action: "navigate", path: "/" }],
      assertions: [{ id: "ok", type: "ui", contains: "unused", oracle: "human-approved" }],
      policy,
    },
    {
      headless: true,
      env: { baseUrl: "http://127.0.0.1:9" },
      artifactsDir: dir,
    },
  );
  assert.equal(run.status, "failed");
  assert.equal(run.metrics.failureKind, "ENVIRONMENT");
  assert.equal(run.metrics.attemptCount, 2);
  assert.equal(run.metrics.flakeRecovery, undefined);
});

test("does not retry assertion failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "testpilot-retry-assert-"));
  const run = await runTestIR(
    {
      id: "retry-assert",
      version: 1,
      platform: "web",
      steps: [{ id: "open", action: "navigate", path: "/" }],
      assertions: [
        { id: "never-there", type: "ui", contains: "THIS-TEXT-SHOULD-NOT-EXIST", oracle: "human-approved" },
      ],
      policy,
    },
    {
      headless: true,
      env: { baseUrl: "http://127.0.0.1:4173" },
      artifactsDir: dir,
    },
  );
  assert.equal(run.status, "failed");
  assert.equal(run.metrics.failureKind, "PRODUCT_DEFECT");
  assert.equal(run.metrics.attemptCount, 1);
});

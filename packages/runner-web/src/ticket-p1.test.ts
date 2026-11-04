import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import type { RunEnvironment } from "@testpilot/fixtures";
import { runTestIR } from "./run.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const demoDir = join(root, "examples/demo-webapp");

const env: RunEnvironment = {
  baseUrl: "http://127.0.0.1:4173",
};

test("P-1 demo ticket: region required negative passes; full submit hits HTTP", async () => {
  const demo = spawn("node", ["server.mjs"], { cwd: demoDir, stdio: "ignore" });
  await sleep(1500);
  try {
    const negative = JSON.parse(
      readFileSync(join(demoDir, "tests/demo-ticket-no-attachment.json"), "utf8"),
    );
    const neg = await runTestIR(negative, { env, headless: true });
    assert.equal(neg.status, "passed", neg.steps.find((s) => s.message)?.message);

    const success = JSON.parse(
      readFileSync(join(demoDir, "tests/demo-ticket-submit-success.json"), "utf8"),
    );
    const ok = await runTestIR(success, { env, headless: true });
    assert.equal(ok.status, "passed", ok.steps.find((s) => s.message)?.message);
    const api = ok.assertions.find((a) => a.assertionId === "ticket-submitted-api");
    assert.equal(api?.passed, true);
  } finally {
    demo.kill("SIGTERM");
  }
});

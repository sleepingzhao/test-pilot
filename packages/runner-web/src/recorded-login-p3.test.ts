import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { eventsToIR } from "@testpilot/recorder-web";
import { waitForHttpReady, type RunEnvironment } from "@testpilot/fixtures";
import type { RecordedEvent } from "@testpilot/recorder-web";
import { runTestIR } from "./run.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const demoDir = join(root, "examples/demo-webapp");
const PRACTICE_LOGIN_RECORD_EVENTS = JSON.parse(
  readFileSync(join(demoDir, "recorder/practice-login-events.json"), "utf8"),
) as RecordedEvent[];

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

test("P-3 recorded login IR replays with env refs on practice login page", async () => {
  const prevPhone = process.env.TESTPILOT_ENV_ADMIN_PHONE;
  const prevPass = process.env.TESTPILOT_ENV_ADMIN_PASSWORD;
  process.env.TESTPILOT_ENV_ADMIN_PHONE = "19900008888";
  process.env.TESTPILOT_ENV_ADMIN_PASSWORD = "practice-secret";

  const url = "http://127.0.0.1:4173/practice-login.html";
  const demo = (await reachable(url)) ? undefined : spawn("node", ["server.mjs"], { cwd: demoDir, stdio: "ignore" });
  try {
    await waitForHttpReady("http://127.0.0.1:4173/");
    const ir = eventsToIR(
      "rec-practice-login",
      "http://127.0.0.1:4173/practice-login.html",
      PRACTICE_LOGIN_RECORD_EVENTS,
    );
    ir.assertions = [
      { id: "after-login", type: "ui", contains: "我的工单", oracle: "human-approved" },
    ];
    ir.steps.push({ id: "wait-home", action: "wait", target: { name: "我的工单" } });

    const env: RunEnvironment = { baseUrl: "http://127.0.0.1:4173" };
    const run = await runTestIR(ir, { env, headless: true });
    assert.equal(
      run.status,
      "passed",
      run.steps.find((s) => s.message)?.message ?? run.assertions.find((a) => !a.passed)?.message,
    );
  } finally {
    demo?.kill("SIGTERM");
    if (prevPhone === undefined) delete process.env.TESTPILOT_ENV_ADMIN_PHONE;
    else process.env.TESTPILOT_ENV_ADMIN_PHONE = prevPhone;
    if (prevPass === undefined) delete process.env.TESTPILOT_ENV_ADMIN_PASSWORD;
    else process.env.TESTPILOT_ENV_ADMIN_PASSWORD = prevPass;
  }
});

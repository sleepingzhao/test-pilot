#!/usr/bin/env node
/**
 * Headless demo regression (no API): starts static demo on 4173, runs two IR smokes.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const demoDir = join(root, "examples/demo-webapp");
const tests = [
  "examples/demo-webapp/tests/demo-users-smoke.json",
  "examples/demo-webapp/tests/demo-ticket-no-attachment.json",
  "examples/demo-webapp/tests/demo-duplicate-email.json",
];

const demo = spawn("node", ["server.mjs"], {
  cwd: demoDir,
  stdio: "ignore",
});

await sleep(1500);

let failed = false;
try {
  for (const t of tests) {
    const proc = spawn(
      "pnpm",
      ["cli", "run", t, "--base-url", "http://127.0.0.1:4173", "-o", "artifacts/smoke-last.json"],
      { cwd: root, stdio: "inherit" },
    );
    const code = await new Promise((resolve) => proc.on("close", resolve));
    if (code !== 0) {
      failed = true;
      console.error(`Smoke failed: ${t}`);
    } else {
      console.log(`Smoke passed: ${t}`);
    }
  }
} finally {
  demo.kill("SIGTERM");
}

process.exit(failed ? 1 : 0);

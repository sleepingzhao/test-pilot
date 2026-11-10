#!/usr/bin/env node
/**
 * Headless demo regression (no API): starts static demo on 4173, runs two IR smokes.
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const demoDir = join(root, "examples/demo-webapp");
const smokeDir = join(root, "artifacts", "smoke");
const smokeRuns = join(smokeDir, "runs");
const smokeOut = join(smokeDir, "smoke-last.json");

/** Smoke evidence is per-run too; keep the newest buckets so reruns do not pile up. */
async function pruneSmokeRuns(keep = 8) {
  let names;
  try {
    names = (await readdir(smokeRuns, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return;
  }
  if (names.length <= keep) return;
  const stamped = await Promise.all(
    names.map(async (name) => ({ name, mtime: (await stat(join(smokeRuns, name))).mtimeMs })),
  );
  stamped.sort((a, b) => b.mtime - a.mtime);
  for (const item of stamped.slice(keep)) {
    await rm(join(smokeRuns, item.name), { recursive: true, force: true });
  }
}
const tests = [
  "examples/demo-webapp/tests/demo-users-smoke.json",
  "examples/demo-webapp/tests/demo-ticket-submit-success.json",
  "examples/demo-webapp/tests/demo-duplicate-email.json",
  "examples/demo-webapp/tests/demo-create-user-success.json",
  "examples/demo-webapp/tests/api-user-create.json",
  "examples/demo-webapp/tests/api-duplicate-email.json",
  "examples/demo-webapp/tests/api-missing-email.json",
  "examples/demo-webapp/tests/api-items-cleanup.json",
];

const demo = spawn("node", ["server.mjs"], {
  cwd: demoDir,
  stdio: "ignore",
});

await sleep(1500);

let failed = false;
try {
  await mkdir(smokeRuns, { recursive: true });
  for (const t of tests) {
    const proc = spawn(
      "pnpm",
      [
        "cli",
        "run",
        t,
        "--base-url",
        "http://127.0.0.1:4173",
        "--artifacts",
        smokeRuns,
        "-o",
        smokeOut,
      ],
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
  await pruneSmokeRuns().catch(() => undefined);
  demo.kill("SIGTERM");
}

process.exit(failed ? 1 : 0);

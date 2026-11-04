#!/usr/bin/env node
import { writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runNegativeProbeCatalog } from "../packages/runner-web/dist/negative-probes.js";
import { waitForHttpReady } from "../packages/fixtures/dist/wait-ready.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const demoDir = join(root, "examples/demo-webapp");
const outPath = join(root, "artifacts/negative-probes-last.json");

const demo = spawn("node", ["server.mjs"], { cwd: demoDir, stdio: "ignore" });
await waitForHttpReady("http://127.0.0.1:4173/");

let exitCode = 0;
try {
  const report = await runNegativeProbeCatalog(root, {
    baseUrl: "http://127.0.0.1:4173",
  });
  await mkdir(join(root, "artifacts"), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2));
  if (!report.ok) {
    console.error("Negative probe failures:", JSON.stringify(report.probes.filter((p) => !p.ok), null, 2));
    exitCode = 1;
  } else {
    console.log(`Negative probes OK (${report.probes.length} providers)`);
  }
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  demo.kill("SIGTERM");
}

process.exit(exitCode);

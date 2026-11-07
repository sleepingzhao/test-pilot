#!/usr/bin/env node
import { writeFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runNegativeProbeCatalog } from "../packages/runner-web/dist/negative-probes.js";
import { waitForHttpReady } from "../packages/fixtures/dist/wait-ready.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const demoDir = join(root, "examples/demo-webapp");
const artifactsRoot = join(root, "artifacts");
const probesDir = join(artifactsRoot, "probes");
const outPath = join(artifactsRoot, "negative-probes-last.json");

/** Probe folders are gate evidence; keep the newest 20 so the artifacts root stays tidy. */
async function pruneProbes(keep = 20) {
  let names;
  try {
    names = (await readdir(probesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return;
  }
  if (names.length <= keep) return;
  const stamped = await Promise.all(
    names.map(async (name) => ({ name, mtime: (await stat(join(probesDir, name))).mtimeMs })),
  );
  stamped.sort((a, b) => b.mtime - a.mtime);
  for (const item of stamped.slice(keep)) {
    await rm(join(probesDir, item.name), { recursive: true, force: true });
  }
}

const demo = spawn("node", ["server.mjs"], { cwd: demoDir, stdio: "ignore" });
let exitCode = 0;
try {
  await waitForHttpReady("http://127.0.0.1:4173/");
  const report = await runNegativeProbeCatalog(
    root,
    { baseUrl: "http://127.0.0.1:4173" },
    { artifactsDir: probesDir },
  );
  await mkdir(artifactsRoot, { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2));
  await pruneProbes();
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

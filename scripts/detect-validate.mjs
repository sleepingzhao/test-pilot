#!/usr/bin/env node
/**
 * Manual capability-detection validation. Requires the API (default :8787) and
 * the target environment (demo :4173 / pilot) to be reachable. Not part of
 * `pnpm verify` because the pilot needs credentials and a live remote system.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiBase = (process.env.TESTPILOT_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");

const EXPECTED = {
  demo: ["crud", "file-media", "search-filter"],
  pilot: ["file-media", "workflow"],
  real: ["realtime-messaging"],
};

/** File/media depends on which real views load in time; report it but do not fail. */
const OPTIONAL = {
  real: ["file-media"],
};

function argValue(name) {
  const eq = process.argv.find((item) => item.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const requested = argValue("--target") ?? "demo";
const targets = requested === "all" ? ["demo", "pilot"] : [requested];
if (targets.some((target) => !EXPECTED[target])) {
  console.error(`Unknown target: ${requested}. Use demo, pilot, real, or all.`);
  process.exit(2);
}

async function getJson(path) {
  const res = await fetch(`${apiBase}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function postJson(path, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function runTarget(target) {
  const before = (await getJson("/api/environment")).llmUsage;
  const { jobId } = await postJson("/api/detect/jobs", { target });
  let job;
  for (let i = 0; i < 240; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    job = await getJson(`/api/detect/jobs/${jobId}`);
    if (job.status !== "running") break;
  }
  const after = (await getJson("/api/environment")).llmUsage;
  if (!job || job.status !== "completed") {
    throw new Error(`${target} detection failed: ${job?.error ?? "timeout"}`);
  }
  const capabilities = job.result.profile.capabilities;
  const ids = capabilities.map((item) => item.id);
  const missing = EXPECTED[target].filter((id) => !ids.includes(id));
  const optionalMissing = (OPTIONAL[target] ?? []).filter((id) => !ids.includes(id));
  const llmCalls = (after.callCount ?? 0) - (before.callCount ?? 0);
  return {
    target,
    ok: missing.length === 0 && llmCalls === 0,
    detectionId: job.result.id,
    url: job.result.url,
    capabilities: capabilities.map((item) => ({
      id: item.id,
      confidence: Number(item.confidence.toFixed(2)),
      requires: item.requires,
      signals: item.signals,
    })),
    questions: job.result.profile.questions,
    missing,
    optionalMissing,
    llmCalls,
  };
}

const results = [];
for (const target of targets) {
  process.stdout.write(`detecting ${target}... `);
  try {
    const result = await runTarget(target);
    results.push(result);
    console.log(
      result.ok
        ? `OK (${result.capabilities.map((item) => `${item.id}:${item.confidence}`).join(", ")})`
        : `FAIL (missing=${result.missing.join(",") || "none"}, llmCalls=${result.llmCalls})`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ target, ok: false, error: message });
    console.log(`FAIL (${message})`);
  }
}

const reportPath = join(root, "artifacts", "detect", "validate-last.json");
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(
  reportPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), apiBase, results }, null, 2),
);
console.log(`report: ${reportPath}`);

if (results.some((result) => !result.ok)) process.exitCode = 1;

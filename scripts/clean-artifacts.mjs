#!/usr/bin/env node
/**
 * Keep artifact run directories bounded.
 * Usage: node scripts/clean-artifacts.mjs [--keep 50] [--days 7] [--dry-run]
 * Files such as negative-probes-last.json are never removed.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsRoot = join(root, "artifacts");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

const keep = Number(option("--keep") ?? 50);
const days = option("--days");

if (!Number.isInteger(keep) || keep < 1) {
  console.error("--keep must be a positive integer");
  process.exit(2);
}
if (days !== undefined && (!Number.isFinite(Number(days)) || Number(days) <= 0)) {
  console.error("--days must be a positive number");
  process.exit(2);
}

let entries;
try {
  entries = await readdir(artifactsRoot, { withFileTypes: true });
} catch (err) {
  if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
    console.log("artifacts/ does not exist; nothing to clean.");
    process.exit(0);
  }
  throw err;
}

const dirs = [];
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const path = join(artifactsRoot, entry.name);
  const info = await stat(path);
  dirs.push({ name: entry.name, path, mtimeMs: info.mtimeMs });
}
dirs.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));

const cutoff = days === undefined ? Number.NEGATIVE_INFINITY : Date.now() - Number(days) * 86_400_000;
const toRemove = dirs.filter((dir, index) => index >= keep || dir.mtimeMs < cutoff);

for (const dir of toRemove) {
  if (dryRun) {
    console.log(`[dry-run] remove artifacts/${dir.name}`);
    continue;
  }
  await rm(dir.path, { recursive: true, force: true });
  console.log(`removed artifacts/${dir.name}`);
}

console.log(
  `${dryRun ? "Would remove" : "Removed"} ${toRemove.length}/${dirs.length} artifact directories; ` +
    `kept ${dirs.length - toRemove.length}.`,
);

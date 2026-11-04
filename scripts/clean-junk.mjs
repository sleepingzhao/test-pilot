#!/usr/bin/env node
/**
 * Remove common OS/editor/build junk outside generated evidence directories.
 * Usage: node scripts/clean-junk.mjs [--dry-run]
 */
import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const skipDirs = new Set(["node_modules", ".git", "dist", "artifacts", "data"]);
const junkNames = new Set([".DS_Store", "Thumbs.db"]);
const junkSuffixes = [
  ".log",
  ".tmp",
  ".temp",
  ".bak",
  ".orig",
  ".rej",
  ".swp",
  ".swo",
  ".tsbuildinfo",
  ".pid",
  ".sock",
  ".junit.xml",
  ".heapsnapshot",
];

function isJunk(name) {
  return junkNames.has(name) || name.endsWith("~") || junkSuffixes.some((suffix) => name.endsWith(suffix));
}

const removed = [];
const failures = [];

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    failures.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      await walk(join(dir, entry.name));
      continue;
    }
    if (!entry.isFile() || !isJunk(entry.name)) continue;
    const path = join(dir, entry.name);
    if (dryRun) {
      console.log(`[dry-run] remove ${path.slice(root.length + 1)}`);
      removed.push(path);
      continue;
    }
    try {
      await rm(path, { force: true });
      console.log(`removed ${path.slice(root.length + 1)}`);
      removed.push(path);
    } catch (err) {
      failures.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

await walk(root);

// Generated directories are skipped above; still remove OS metadata at their roots.
for (const name of ["artifacts", "data"]) {
  const dir = join(root, name);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !junkNames.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (dryRun) {
      console.log(`[dry-run] remove ${path.slice(root.length + 1)}`);
      removed.push(path);
      continue;
    }
    try {
      await rm(path, { force: true });
      console.log(`removed ${path.slice(root.length + 1)}`);
      removed.push(path);
    } catch (err) {
      failures.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

console.log(`${dryRun ? "Would remove" : "Removed"} ${removed.length} junk file(s).`);
if (failures.length) {
  console.error(`Failed to clean ${failures.length} path(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}

#!/usr/bin/env node
/**
 * Artifact retention — only deletes under artifacts/runs/*.
 * Default: dry-run. Pass --execute to delete.
 *
 * Usage: pnpm clean:artifacts [--keep-batches 12] [--days 14] [--max-mb 512] [--execute]
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCleanupDays,
  parseKeepBatches,
  runArtifactCleanupCli,
} from "../services/test-management/src/artifact-cleanup.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dryRun = !args.includes("--execute");
const VALUE_FLAGS = new Set(["--keep-batches", "--keep", "--days", "--max-mb"]);

function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function validateArgs() {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") continue;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    if (arg === "--execute" || arg === "--help") continue;
    if (!VALUE_FLAGS.has(arg)) throw new Error(`unknown flag: ${arg}`);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    i += 1;
  }
}

try {
  validateArgs();
  const keepBatches = parseKeepBatches(option("--keep-batches") ?? option("--keep"));
  const days = parseCleanupDays(option("--days") ?? "14");
  const maxMb = option("--max-mb");
  const maxTotalBytes = maxMb == null ? null : Number(maxMb) * 1024 * 1024;
  if (maxTotalBytes != null && (!Number.isFinite(maxTotalBytes) || maxTotalBytes <= 0)) {
    console.error("--max-mb must be a positive number");
    process.exit(2);
  }

  const plan = await runArtifactCleanupCli({
    repoRoot: root,
    keepBatches,
    days,
    maxTotalBytes,
    dryRun,
  });

  for (const item of plan.toRemove) {
    console.log(`${dryRun ? "[dry-run]" : "remove"} artifacts/runs/${item.runId} (${item.reason}, ${item.bytes} B)`);
  }
  console.log(
    `${dryRun ? "Would remove" : "Removed"} ${plan.toRemove.length} run dirs; ` +
      `keep ${plan.toKeep.length}; protected batch runs ${plan.protectedRunIds.length}; ` +
      `bytes ${plan.totalBytesBefore} → ${plan.totalBytesAfter}`,
  );
  if (dryRun) {
    console.log("Dry-run only. Re-run with --execute to delete.");
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}

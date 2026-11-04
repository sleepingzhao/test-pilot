import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readConfigFile(repoRoot: string, name: string): unknown | undefined {
  try {
    const raw = readFileSync(join(repoRoot, "docs", name), "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Deterministic hash of assertion DB + agent config files (not IR). */
export function computeAssertionConfigHash(repoRoot: string): string {
  const snapshot: Record<string, unknown> = {};
  for (const name of ["assertion-db-config.json", "assertion-db-config.example.json"] as const) {
    const doc = readConfigFile(repoRoot, name);
    if (doc) {
      snapshot.db = doc;
      break;
    }
  }
  for (const name of ["assertion-agent-config.json", "assertion-agent-config.example.json"] as const) {
    const doc = readConfigFile(repoRoot, name);
    if (doc) {
      snapshot.agent = doc;
      break;
    }
  }
  const canonical = JSON.stringify(snapshot);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type DbConfigBundle = {
  connectionRef: string;
  queries: Record<string, string>;
  allowedTables: string[];
};

export type AssertionDbConfigFile = {
  version: number;
  dbs: Record<string, DbConfigBundle>;
};

const ENV_REF_PREFIX = "env.";

export function resolveConfigEnvRef(ref: string): string | undefined {
  if (!ref.startsWith(ENV_REF_PREFIX)) return undefined;
  const key = ref.slice(ENV_REF_PREFIX.length);
  const envKey =
    key === "PILOT_DB_URL"
      ? "TESTPILOT_PILOT_DB_URL"
      : `TESTPILOT_${key.replace(/[.-]/g, "_").toUpperCase()}`;
  const value = process.env[envKey]?.trim();
  return value || undefined;
}

let cachedConfigs: Record<string, DbConfigBundle> | undefined;

export function loadAssertionDbConfigs(repoRoot?: string): Record<string, DbConfigBundle> {
  if (cachedConfigs) return cachedConfigs;
  const root =
    repoRoot ?? join(dirname(fileURLToPath(import.meta.url)), "../../..");
  for (const name of ["assertion-db-config.json", "assertion-db-config.example.json"]) {
    try {
      const raw = readFileSync(join(root, "docs", name), "utf8");
      const parsed = JSON.parse(raw) as AssertionDbConfigFile;
      cachedConfigs = parsed.dbs ?? {};
      return cachedConfigs;
    } catch {
      /* try next */
    }
  }
  cachedConfigs = {};
  return cachedConfigs;
}

export function getDbConfigBundle(configRef: string, repoRoot?: string): DbConfigBundle | undefined {
  return loadAssertionDbConfigs(repoRoot)[configRef];
}

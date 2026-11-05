import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeAssertionConfigHash,
  registerAssertionConfigCacheInvalidator,
} from "./config-hash.js";

export type AgentConfigBundle = {
  /** Directory (repo-relative) containing `{traceRef}.json` trace files */
  tracesDir?: string;
  /** Optional OTel service name filter when parsing exports */
  service?: string;
};

export type AssertionAgentConfigFile = {
  version: number;
  agents: Record<string, AgentConfigBundle>;
};

let cachedConfigs: Record<string, AgentConfigBundle> | undefined;
let cachedAtHash: string | undefined;

registerAssertionConfigCacheInvalidator(() => {
  cachedConfigs = undefined;
  cachedAtHash = undefined;
});

export function loadAssertionAgentConfigs(
  repoRoot?: string,
  opts?: { fresh?: boolean },
): Record<string, AgentConfigBundle> {
  const root =
    repoRoot ?? join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const currentHash = computeAssertionConfigHash(root);
  if (cachedConfigs && cachedAtHash === currentHash && !opts?.fresh) {
    return cachedConfigs;
  }
  for (const name of ["assertion-agent-config.json", "assertion-agent-config.example.json"]) {
    try {
      const raw = readFileSync(join(root, "docs", name), "utf8");
      const parsed = JSON.parse(raw) as AssertionAgentConfigFile;
      cachedConfigs = parsed.agents ?? {};
      cachedAtHash = currentHash;
      return cachedConfigs;
    } catch {
      /* try next */
    }
  }
  cachedConfigs = {};
  cachedAtHash = currentHash;
  return cachedConfigs;
}

export function getAgentConfigBundle(configRef: string, repoRoot?: string): AgentConfigBundle | undefined {
  return loadAssertionAgentConfigs(repoRoot)[configRef];
}

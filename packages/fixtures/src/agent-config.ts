import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

export function loadAssertionAgentConfigs(repoRoot?: string): Record<string, AgentConfigBundle> {
  if (cachedConfigs) return cachedConfigs;
  const root =
    repoRoot ?? join(dirname(fileURLToPath(import.meta.url)), "../../..");
  for (const name of ["assertion-agent-config.json", "assertion-agent-config.example.json"]) {
    try {
      const raw = readFileSync(join(root, "docs", name), "utf8");
      const parsed = JSON.parse(raw) as AssertionAgentConfigFile;
      cachedConfigs = parsed.agents ?? {};
      return cachedConfigs;
    } catch {
      /* try next */
    }
  }
  cachedConfigs = {};
  return cachedConfigs;
}

export function getAgentConfigBundle(configRef: string, repoRoot?: string): AgentConfigBundle | undefined {
  return loadAssertionAgentConfigs(repoRoot)[configRef];
}

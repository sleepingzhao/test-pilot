import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NegativeProbeReport } from "@testpilot/runner-web";

export async function readNegativeProbeReport(repoRoot: string): Promise<NegativeProbeReport | null> {
  try {
    const raw = await readFile(join(repoRoot, "artifacts/negative-probes-last.json"), "utf8");
    return JSON.parse(raw) as NegativeProbeReport;
  } catch {
    return null;
  }
}

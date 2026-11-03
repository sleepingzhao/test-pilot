import { createHash } from "node:crypto";
import type { TestIR } from "./types.js";

/** Stable hash for versioning / dedup (canonical JSON). */
export function computeIRHash(ir: TestIR): string {
  const canonical = JSON.stringify(ir, Object.keys(ir).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

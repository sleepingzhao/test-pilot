import { createHash } from "node:crypto";
import type { TestIR } from "./types.js";

/** Bump when the canonicalization changes so stored hashes can be migrated. */
export const IR_HASH_VERSION = 2;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

/** Stable hash for versioning / dedup (recursively sorted JSON). */
export function computeIRHash(ir: TestIR): string {
  const canonical = JSON.stringify(canonicalize(ir));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

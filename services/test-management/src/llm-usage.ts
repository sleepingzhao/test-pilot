import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type UsageState = { tokensTotal: number; callCount: number; lastError: string | null };

let state: UsageState = { tokensTotal: 0, callCount: 0, lastError: null };
let usageFile: string | null = null;

/** Load cumulative counters so a server restart does not hide prior LLM usage. */
export function initLlmUsage(filePath: string): void {
  usageFile = filePath;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<UsageState>;
    state = {
      tokensTotal: Number(raw.tokensTotal) || 0,
      callCount: Number(raw.callCount) || 0,
      lastError: typeof raw.lastError === "string" ? raw.lastError : null,
    };
  } catch {
    /* first run */
  }
}

function persist(): void {
  if (!usageFile) return;
  try {
    mkdirSync(dirname(usageFile), { recursive: true });
    writeFileSync(
      usageFile,
      `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    /* usage persistence must never break a run */
  }
}

export function recordLlmUsage(tokens: number): void {
  state.lastError = null;
  if (!tokens || tokens < 0) return;
  state.tokensTotal += tokens;
  state.callCount += 1;
  persist();
}

export function recordLlmFailure(message: string): void {
  state.lastError = message.slice(0, 240);
  persist();
}

export function llmUsageSnapshot(): UsageState & { lastError: string | null } {
  return { ...state };
}

export function resetLlmUsageForTests(): void {
  state = { tokensTotal: 0, callCount: 0, lastError: null };
  usageFile = null;
}

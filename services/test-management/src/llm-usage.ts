let sessionTokensTotal = 0;
let sessionCallCount = 0;
let lastError: string | null = null;

export function recordLlmUsage(tokens: number): void {
  lastError = null;
  if (!tokens || tokens < 0) return;
  sessionTokensTotal += tokens;
  sessionCallCount += 1;
}

export function recordLlmFailure(message: string): void {
  lastError = message.slice(0, 240);
}

export function llmUsageSnapshot(): { tokensTotal: number; callCount: number; lastError: string | null } {
  return { tokensTotal: sessionTokensTotal, callCount: sessionCallCount, lastError };
}

export function resetLlmUsageForTests(): void {
  sessionTokensTotal = 0;
  sessionCallCount = 0;
  lastError = null;
}

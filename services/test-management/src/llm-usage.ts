let sessionTokensTotal = 0;
let sessionCallCount = 0;

export function recordLlmUsage(tokens: number): void {
  if (!tokens || tokens < 0) return;
  sessionTokensTotal += tokens;
  sessionCallCount += 1;
}

export function llmUsageSnapshot(): { tokensTotal: number; callCount: number } {
  return { tokensTotal: sessionTokensTotal, callCount: sessionCallCount };
}

export function resetLlmUsageForTests(): void {
  sessionTokensTotal = 0;
  sessionCallCount = 0;
}

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { enhanceDraftWithLlm } from "./llm-planner.js";
import type { LlmPlannerConfig } from "./llm-config.js";

test("retries with the provider's max_tokens limit instead of failing the call", async () => {
  const seen: number[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as { max_tokens: number };
      seen.push(body.max_tokens);
      if (body.max_tokens > 1000) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "Invalid max_tokens value, the valid range of max_tokens is [1, 1000]" },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          usage: { total_tokens: 12 },
          choices: [
            {
              message: {
                content: JSON.stringify({ uncertainties: ["请人工确认"], assertionContains: ["已保存"] }),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const config: LlmPlannerConfig = {
    provider: "deepseek",
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${port}`,
    model: "test-model",
    temperature: 0.2,
    maxTokens: 1_000_000,
    timeoutMs: 5_000,
  };

  try {
    const out = await enhanceDraftWithLlm(config, {
      goal: "提交后提示已保存",
      context: { url: "http://127.0.0.1:4173/", elements: [] },
      ruleDraft: { steps: [], assertions: [], uncertainties: [], sources: ["intent"] },
    });
    assert.deepEqual(seen, [1_000_000, 1_000, 1_000]);
    assert.ok(out.tokensUsed >= 12);
    assert.ok(out.draft.sources.includes("llm-hints"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

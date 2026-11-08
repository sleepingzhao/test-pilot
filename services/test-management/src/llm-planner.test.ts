import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { enhanceDraftWithLlm, chatCompletionsJson } from "./llm-planner.js";
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
                content: JSON.stringify({ uncertainties: ["请人工确认"], assertionContains: ["保存成功"] }),
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

test("drops assertion hints already visible before the action", async () => {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages: Array<{ content: string }> };
      const isStepsCall = body.messages.some((m) => m.content.includes("QA automation planner"));
      const payload = isStepsCall
        ? { steps: [{ id: "s1", action: "click", target: { testId: "open-ticket" } }] }
        : { assertionContains: ["我的工单", "提交成功"] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          usage: { total_tokens: 3 },
          choices: [{ message: { content: JSON.stringify(payload) } }],
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
    maxTokens: 2_000,
    timeoutMs: 5_000,
  };

  try {
    const out = await enhanceDraftWithLlm(config, {
      goal: "提交工单",
      context: {
        url: "http://127.0.0.1:4173/customer",
        elements: [
          { role: "link", name: "我的工单" },
          { role: "button", name: "提交工单", testId: "open-ticket" },
        ],
      },
      ruleDraft: {
        steps: [{ id: "open", action: "click", target: { testId: "open-ticket" } }],
        assertions: [],
        uncertainties: [],
        sources: ["intent"],
      },
    });
    const contains = out.draft.assertions.map((a) => (a as { contains?: string }).contains);
    assert.equal(contains.includes("我的工单"), false);
    assert.equal(contains.includes("提交成功"), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("retries once when the provider returns malformed JSON", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls += 1;
      const content =
        calls === 1 ? '{"assertionContains":["提交成功",]}' : JSON.stringify({ assertionContains: ["提交成功"] });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          usage: { total_tokens: 4 },
          choices: [{ message: { content } }],
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
    maxTokens: 2_000,
    timeoutMs: 5_000,
  };

  try {
    const out = await enhanceDraftWithLlm(config, {
      goal: "提交后提示提交成功",
      context: { url: "http://127.0.0.1:4173/", elements: [] },
      ruleDraft: { steps: [], assertions: [], uncertainties: [], sources: ["intent"] },
    });
    assert.ok(calls >= 2);
    assert.ok(out.tokensUsed >= 8);
    assert.ok(
      out.draft.assertions.some((a) => (a as { contains?: string }).contains === "提交成功"),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("uses LLM steps and drops stale rule assertions when the goal does not mention them", async () => {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages: Array<{ content: string }> };
      const isStepsCall = body.messages.some((m) => m.content.includes("QA automation planner"));
      const payload = isStepsCall
        ? {
            steps: [{ id: "llm-click", action: "click", target: { testId: "open-ticket" } }],
            uncertainties: ["llm"],
          }
        : { uncertainties: ["hint"], assertionContains: ["ok"] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          usage: { total_tokens: 5 },
          choices: [{ message: { content: JSON.stringify(payload) } }],
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
    maxTokens: 2_000,
    timeoutMs: 5_000,
  };
  const ruleSteps = [
    { id: "open-target", action: "navigate" as const, path: "/" },
    { id: "open-ticket", action: "click" as const, target: { testId: "open-ticket" } },
  ];

  try {
    const out = await enhanceDraftWithLlm(config, {
      goal: "提交工单",
      context: {
        url: "http://127.0.0.1:4173/",
        elements: [{ role: "button", name: "提交工单", testId: "open-ticket" }],
      },
      ruleDraft: {
        steps: ruleSteps,
        assertions: [
          { id: "ticket-submitted", type: "ui", contains: "工单已提交", oracle: "human-approved" },
        ],
        uncertainties: [],
        sources: ["intent"],
      },
    });
    assert.deepEqual(
      out.draft.steps.map((s) => s.id),
      ["open-target", "llm-click"],
    );
    assert.equal(
      out.draft.assertions.some((a) => a.id === "ticket-submitted"),
      false,
    );
    assert.ok(out.draft.sources.includes("llm-steps"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("maxOutputTokens bounds a caller that needs a smaller reply budget", async () => {
  let seen = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen = (JSON.parse(raw) as { max_tokens: number }).max_tokens;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          usage: { total_tokens: 5 },
          choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const config: LlmPlannerConfig = {
    provider: "custom",
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${port}`,
    model: "test-model",
    temperature: 0.2,
    maxTokens: 1_000_000,
    timeoutMs: 5_000,
  };
  try {
    const out = await chatCompletionsJson<{ ok: boolean }>(config, {
      system: "s",
      user: "u",
      maxOutputTokens: 8_000,
    });
    assert.equal(seen, 8_000);
    assert.equal(out.parsed.ok, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

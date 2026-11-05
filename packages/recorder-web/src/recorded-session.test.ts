import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateTestIR } from "@testpilot/test-ir";
import { recordSession } from "./record.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const demoDir = join(root, "examples/demo-webapp");
const url = "http://127.0.0.1:4173/practice-login.html";

async function reachable(target: string): Promise<boolean> {
  try {
    const res = await fetch(target);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(target: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await reachable(target)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`demo not reachable: ${target}`);
}

test("recordSession captures a real browser session without plaintext secrets", async () => {
  let demo: ChildProcess | undefined;
  if (!(await reachable(url))) {
    demo = spawn("node", ["server.mjs"], { cwd: demoDir, stdio: "ignore" });
    await waitFor(url);
  }
  try {
    const result = await recordSession({
      url,
      testId: "rec-real-session",
      headless: true,
      onPage: async (page) => {
        await page.getByLabel("手机号").fill("19900008888");
        await page.getByPlaceholder("请输入密码").fill("super-secret-password");
        await page.getByRole("button", { name: "登录" }).click();
        await page.waitForSelector("#home.visible");
        await page.close();
      },
    });

    const fills = result.events.filter((e) => e.kind === "fill");
    assert.equal(fills.length, 2, "both fields should be captured");
    assert.ok(fills.every((f) => f.kind === "fill" && f.sensitive), "credential fields are sensitive");
    assert.ok(result.events.some((e) => e.kind === "click" && e.target.name === "登录"));

    assert.equal(result.ir.steps.find((s) => s.valueRef === "env.adminPhone")?.action, "fill");
    assert.equal(result.ir.steps.find((s) => s.valueRef === "env.adminPassword")?.action, "fill");
    const serialized = JSON.stringify(result.ir);
    assert.doesNotMatch(serialized, /19900008888/);
    assert.doesNotMatch(serialized, /super-secret-password/);
    assert.ok(validateTestIR(result.ir).ok);
    assert.ok(result.warnings.some((w) => /REPLACE_WITH_EXPECTED_TEXT/.test(w)));
  } finally {
    demo?.kill("SIGTERM");
  }
});

test("eventsToIR converts PII-like values to fixture refs", async () => {
  const { eventsToIR } = await import("./record.js");
  const ir = eventsToIR("rec-pii", "http://127.0.0.1:4173/", [
    { kind: "navigate", path: "/" },
    {
      kind: "fill",
      target: { label: "邮箱" },
      value: "real.person@example.com",
      inputKind: "text",
    },
    {
      kind: "fill",
      target: { label: "身份证" },
      value: "110101199001011234",
      inputKind: "text",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(ir), /real\.person@example\.com/);
  assert.doesNotMatch(JSON.stringify(ir), /110101199001011234/);
  const refs = ir.steps.map((s) => s.valueRef).filter(Boolean);
  assert.equal(refs.length, 2);
  assert.ok(refs.every((r) => r!.startsWith("fixture.")));
});

test("eventsToIR emits select steps for native dropdowns", async () => {
  const { eventsToIR } = await import("./record.js");
  const ir = eventsToIR("rec-select", "http://127.0.0.1:4173/", [
    { kind: "navigate", path: "/" },
    {
      kind: "fill",
      target: { label: "优先级" },
      value: "high",
      inputKind: "select",
    },
  ]);
  const step = ir.steps.find((s) => s.action === "select");
  assert.ok(step);
  assert.equal(step.value, "high");
});

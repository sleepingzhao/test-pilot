import type { Locator, TestIR, TestStep } from "@testpilot/test-ir";
import { chromium, type Page } from "playwright";
import type { RecordedEvent } from "./inject.js";
import { RECORDER_INIT_SCRIPT } from "./inject.js";

export type RecordSessionOptions = {
  url: string;
  testId: string;
  /** Tests run headless; interactive recording defaults to a visible window. */
  headless?: boolean;
  /** Test hook: runs after the recorder is installed and the page loaded. */
  onPage?: (page: Page) => Promise<void> | void;
  /** Called when recording finishes (browser closed or stop invoked). */
  onStop?: () => void;
};

export type RecordSessionResult = {
  ir: TestIR;
  events: RecordedEvent[];
  warnings: string[];
};

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function secretRefFor(target: Record<string, string>, fieldKey?: string): string {
  const hint = [fieldKey, target.label, target.name, target.placeholder]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/password|passwd|密码/.test(hint)) return "env.adminPassword";
  if (/phone|mobile|手机|电话/.test(hint)) return "env.adminPhone";
  return `fixture.${slug(fieldKey ?? "secret") || "secret"}`;
}

function toLocator(raw: Record<string, string>): Locator {
  return {
    testId: raw.testId,
    role: raw.role,
    name: raw.name,
    label: raw.label,
    placeholder: raw.placeholder,
    css: raw.css,
  };
}

const PII_VALUE =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|1[3-9]\d{9}|\b\d{17}[\dXx]\b/;

function isPiiValue(value?: string): boolean {
  return Boolean(value && PII_VALUE.test(value));
}

export function eventsToIR(testId: string, baseUrl: string, events: RecordedEvent[]): TestIR {
  const origin = new URL(baseUrl).origin;
  const steps: TestStep[] = [];
  const valueRefs = new Set<string>();
  let clickN = 0;
  let fillN = 0;

  for (const ev of events) {
    if (ev.kind === "navigate") {
      steps.push({
        id: steps.length === 0 ? "open-page" : `navigate-${steps.length}`,
        action: "navigate",
        path: ev.path,
      });
      continue;
    }
    if (ev.kind === "click") {
      clickN += 1;
      const name = ev.target.name ? slug(ev.target.name) : ev.target.testId ?? "target";
      steps.push({
        id: `click-${name}-${clickN}`,
        action: "click",
        target: toLocator(ev.target),
      });
      continue;
    }
    if (ev.kind === "fill") {
      fillN += 1;
      const label = ev.target.label ? slug(ev.target.label) : `field-${fillN}`;
      const action = ev.inputKind === "select" ? "select" : "fill";
      if (ev.sensitive || isPiiValue(ev.value)) {
        const ref = ev.sensitive ? secretRefFor(ev.target, ev.fieldKey) : `fixture.${label || "value"}`;
        valueRefs.add(ref);
        steps.push({
          id: `${action}-${label}-${fillN}`,
          action,
          target: toLocator(ev.target),
          valueRef: ref,
        });
      } else {
        steps.push({
          id: `${action}-${label}-${fillN}`,
          action,
          target: toLocator(ev.target),
          value: ev.value ?? "",
        });
      }
    }
  }

  if (steps.length === 0) {
    /* caller may warn */
  }

  const ir: TestIR = {
    id: testId,
    version: 1,
    platform: "web",
    baseUrl: origin,
    steps,
    assertions: [
      {
        id: "review-after-record",
        type: "ui",
        contains: "REPLACE_WITH_EXPECTED_TEXT",
        oracle: "human-approved",
      },
    ],
    policy: { screenshots: "on-failure", dataIsolation: "per-run" },
  };

  return ir;
}

export function recorderLimitationWarnings(events: RecordedEvent[]): string[] {
  const warnings: string[] = [];
  let cascaderSeen = false;
  const piiFields: string[] = [];
  for (const ev of events) {
    if (ev.kind === "click" && ev.limitation === "cascader" && !cascaderSeen) {
      cascaderSeen = true;
      warnings.push(
        "检测到级联选择器 (cascader) 点击：不支持自动录制；请在 IR 中手动添加 selectCascader 步骤。",
      );
    }
    if (ev.kind === "fill" && !ev.sensitive && isPiiValue(ev.value)) {
      piiFields.push(ev.target.label ?? ev.fieldKey ?? ev.target.name ?? "字段");
    }
  }
  if (piiFields.length) {
    warnings.push(
      `检测到疑似 PII（${piiFields.join("、")}）：已转为 fixture 引用，运行前请配置对应值。`,
    );
  }
  return warnings;
}

/** Fail if serialized IR still embeds obvious secrets from recording. */
export function assertRecordedIrHasNoPlaintextSecrets(ir: TestIR, events: RecordedEvent[]): void {
  const raw = JSON.stringify(ir);
  for (const ev of events) {
    if (ev.kind === "fill" && ev.sensitive && ev.value && raw.includes(ev.value)) {
      throw new Error("recorded IR must not contain sensitive fill values");
    }
  }
  for (const step of ir.steps) {
    if (step.value && isPiiValue(step.value)) {
      throw new Error("recorded IR contains plaintext PII in step value");
    }
  }
}

export async function assertPlaywrightReady(): Promise<void> {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|playwright install/i.test(msg)) {
      throw new Error(
        "Playwright 浏览器未安装。请在 test-pilot 目录执行：pnpm exec playwright install chromium",
      );
    }
    throw err;
  } finally {
    await browser?.close().catch(() => {});
  }
}

export async function recordSession(options: RecordSessionOptions): Promise<RecordSessionResult> {
  const events: RecordedEvent[] = [];
  const warnings: string[] = [];
  const startUrl = options.url;
  const parsed = new URL(startUrl);

  const browser = await chromium.launch({ headless: options.headless ?? false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.exposeBinding("__testpilotRecord", (_source, data: RecordedEvent) => {
    events.push(data);
  });

  await page.addInitScript({ content: RECORDER_INIT_SCRIPT });

  await page.goto(startUrl, { waitUntil: "domcontentloaded" });
  events.push({ kind: "navigate", path: parsed.pathname + parsed.search });

  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const u = frame.url();
    try {
      const next = new URL(u);
      if (next.origin !== parsed.origin) return;
      const path = next.pathname + next.search;
      const last = events.filter((e) => e.kind === "navigate").at(-1);
      if (last && last.kind === "navigate" && last.path === path) return;
      events.push({ kind: "navigate", path });
    } catch {
      /* ignore */
    }
  });

  await page.evaluate(() => {
    const bar = document.createElement("div");
    bar.id = "__testpilot_rec_bar";
    bar.textContent = "TestPilot 录制中 — 关闭本窗口结束并保存";
    bar.setAttribute(
      "style",
      "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#1a1a2e;color:#eee;padding:8px 12px;font:14px system-ui,sans-serif;text-align:center;pointer-events:none;",
    );
    document.documentElement.appendChild(bar);
  });

  const closed = new Promise<void>((resolve) => {
    page.on("close", () => resolve());
    browser.on("disconnected", () => resolve());
  });
  try {
    await options.onPage?.(page);
    await closed;
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }

  try {
    await browser.close();
  } catch {
    /* already closed */
  }

  options.onStop?.();

  const ir = eventsToIR(options.testId, startUrl, events);
  assertRecordedIrHasNoPlaintextSecrets(ir, events);
  if (events.filter((e) => e.kind !== "navigate").length === 0) {
    warnings.push("Only navigation was recorded — try clicking and filling fields before closing.");
  }
  warnings.push(...recorderLimitationWarnings(events));
  const valueRefSteps = ir.steps.filter((s) => s.valueRef);
  if (valueRefSteps.length > 0) {
    warnings.push(
      `Set fixture values when running: ${valueRefSteps.map((s) => s.valueRef).join(", ")}`,
    );
  }
  warnings.push("Edit assertions (replace REPLACE_WITH_EXPECTED_TEXT) before approval.");

  return { ir, events, warnings };
}

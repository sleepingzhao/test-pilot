import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page, Response } from "playwright";

export type ArtifactRef = {
  kind: "trace" | "screenshot" | "har" | "log" | "network";
  path: string;
};

export type RunArtifacts = {
  runId: string;
  dir: string;
  artifacts: ArtifactRef[];
  notes?: string;
};

export type EvidenceOptions = {
  runId: string;
  dir: string;
  screenshots: "never" | "on-failure" | "always";
};

export type NetworkEntry = {
  url: string;
  method: string;
  status?: number;
  resourceType: string;
  /** Truncated POST/PUT body for api-contract assertions (secrets redacted). */
  requestBody?: string;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
};

import {
  redactForEvidence,
  redactHeaders,
  redactStringBody,
  redactUrl,
} from "./redact.js";

function pickResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (Object.keys(out).length >= 24) break;
    out[k] = v.slice(0, 500);
  }
  return out;
}

export function createEvidenceCollector(options: EvidenceOptions) {
  const runDir = join(options.dir, options.runId);
  const artifacts: ArtifactRef[] = [];
  let context: BrowserContext | undefined;
  const network: NetworkEntry[] = [];
  const networkPending: Promise<void>[] = [];

  /** Long-lived/streaming responses never finish their body; never block the run on them. */
  async function settleNetwork(timeoutMs = 8_000) {
    const settled = Promise.all(networkPending).catch(() => undefined);
    await Promise.race([settled, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  }

  async function writeNetworkLog() {
    const path = join(runDir, "network.json");
    const redacted = network.map((n) =>
      redactForEvidence({
        ...n,
        url: redactUrl(n.url),
        requestBody: n.requestBody ? redactStringBody(n.requestBody) : undefined,
        responseBody: n.responseBody ? redactStringBody(n.responseBody) : undefined,
        responseHeaders: redactHeaders(n.responseHeaders),
      }),
    );
    await writeFile(path, JSON.stringify(redacted, null, 2));
    if (!artifacts.some((a) => a.kind === "network")) {
      artifacts.push({ kind: "network", path });
    }
  }

  return {
    getNetworkLog(): NetworkEntry[] {
      return [...network];
    },

    async waitForNetworkCapture(): Promise<void> {
      await settleNetwork();
    },

    /** Polls for a matching response; clicks can issue requests after networkidle already settled. */
    async waitForNetworkEntry(
      predicate: (entry: NetworkEntry) => boolean,
      timeoutMs = 10_000,
    ): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        await settleNetwork(1_000);
        if (network.some(predicate)) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },

    async attachPage(ctx: BrowserContext, page: Page) {
      context = ctx;
      await mkdir(runDir, { recursive: true });
      await ctx.tracing.start({ screenshots: true, snapshots: true, sources: true });
      page.on("response", (res: Response) => {
        const req = res.request();
        if (network.length > 200) return;
        const post = req.postData();
        const entry: NetworkEntry = {
          url: req.url().slice(0, 500),
          method: req.method(),
          status: res.status(),
          resourceType: req.resourceType(),
        };
        if (post && post.length > 0 && post.length <= 8000) {
          entry.requestBody = post.slice(0, 4000);
        }
        try {
          const picked = pickResponseHeaders(res.headers());
          entry.responseHeaders = picked;
        } catch {
          /* ignore */
        }
        network.push(entry);
        const contentType = (entry.responseHeaders?.["content-type"] ?? "").toLowerCase();
        if (contentType.includes("text/event-stream")) return;
        networkPending.push(
          (async () => {
            try {
              const lenHeader = res.headers()["content-length"];
              const len = lenHeader ? Number(lenHeader) : 0;
              if (len > 8000) return;
              const text = await Promise.race([
                res.text().catch(() => ""),
                new Promise<string>((resolve) => setTimeout(() => resolve(""), 5_000)),
              ]);
              if (text.length > 0 && text.length <= 8000) {
                entry.responseBody = text.slice(0, 4000);
              }
            } catch {
              /* response may be aborted */
            }
          })(),
        );
      });
    },

    async captureFailure(page: Page, label: string) {
      if (options.screenshots === "never") return;
      const file = join(runDir, `failure-${label}.png`);
      await page.screenshot({ path: file, fullPage: true });
      artifacts.push({ kind: "screenshot", path: file });
      await writeNetworkLog();
    },

    async finalize(status: string): Promise<RunArtifacts> {
      await mkdir(runDir, { recursive: true });
      await writeNetworkLog();
      if (context) {
        const tracePath = join(runDir, "trace.zip");
        await context.tracing.stop({ path: tracePath });
        artifacts.push({ kind: "trace", path: tracePath });
      }
      const manifest = { runId: options.runId, status, artifacts };
      const manifestPath = join(runDir, "manifest.json");
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      artifacts.push({ kind: "log", path: manifestPath });
      return { runId: options.runId, dir: runDir, artifacts };
    },
  };
}

export type FailureClassifierInput = {
  stepError?: string;
  assertionMessage?: string;
  httpStatus?: number;
};

export {
  redactForEvidence,
  redactHeaders,
  redactStringBody,
  redactStrings,
  redactUrl,
} from "./redact.js";

export function classifyFailure(input: FailureClassifierInput): string {
  const stepError = input.stepError?.toLowerCase() ?? "";
  if (stepError.includes("timeout") || input.httpStatus === 503) {
    return "ENVIRONMENT";
  }
  if (
    stepError.includes("net::") ||
    stepError.includes("err_") ||
    stepError.includes("browser has been closed") ||
    stepError.includes("target page, context or browser")
  ) {
    return "ENVIRONMENT";
  }
  if (stepError.includes("locator") || stepError.includes("strict mode")) {
    return "LOCATOR_BREAKAGE";
  }
  if (input.assertionMessage) {
    return "PRODUCT_DEFECT";
  }
  return "UNKNOWN";
}

export function isTransientFailure(message?: string): boolean {
  if (!message) return false;
  return /timeout|net::|ERR_|503|ECONNRESET/i.test(message);
}

export {
  maxRunAttempts,
  normalizeRetryKind,
  shouldRetryAfterFailure,
  type RetryDecisionInput,
  type RetryPolicy,
} from "./retry-policy.js";

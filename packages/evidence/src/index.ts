import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page, Request, Response } from "playwright";

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
  /** Set for direct `request` steps so assertions can bind by step id. */
  stepId?: string;
  /** Truncated POST/PUT body for api-contract assertions (secrets redacted). */
  requestBody?: string;
  responseBody?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
};

export type DirectNetworkInput = {
  url: string;
  method: string;
  status?: number;
  stepId?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
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
  const inFlight = new Set<Request>();

  /** Long-lived/streaming responses never finish their body; never block the run on them. */
  async function settleNetwork(timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await Promise.allSettled(networkPending);
      if (inFlight.size === 0) return;
      // A click's fetch has been dispatched but its response has not arrived yet.
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  async function writeNetworkLog() {
    const path = join(runDir, "network.json");
    const redacted = network.map((n) =>
      redactForEvidence({
        ...n,
        url: redactUrl(n.url),
        requestBody: n.requestBody ? redactStringBody(n.requestBody) : undefined,
        responseBody: n.responseBody ? redactStringBody(n.responseBody) : undefined,
        requestHeaders: redactHeaders(n.requestHeaders),
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

    /** Records a direct `request` step. Same truncation as page captures; redaction happens on write. */
    recordNetworkEntry(input: DirectNetworkInput) {
      if (network.length > 200) return;
      const entry: NetworkEntry = {
        url: input.url.slice(0, 500),
        method: input.method,
        status: input.status,
        resourceType: "fetch",
        ...(input.stepId ? { stepId: input.stepId } : {}),
      };
      if (input.requestBody && input.requestBody.length > 0 && input.requestBody.length <= 8000) {
        entry.requestBody = input.requestBody.slice(0, 4000);
      }
      if (input.responseBody && input.responseBody.length > 0 && input.responseBody.length <= 8000) {
        entry.responseBody = input.responseBody.slice(0, 4000);
      }
      if (input.requestHeaders) entry.requestHeaders = pickResponseHeaders(input.requestHeaders);
      if (input.responseHeaders) entry.responseHeaders = pickResponseHeaders(input.responseHeaders);
      network.push(entry);
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
      page.on("request", (req: Request) => {
        const type = req.resourceType();
        if (type === "xhr" || type === "fetch" || type === "document") inFlight.add(req);
      });
      const finish = (req: Request) => {
        inFlight.delete(req);
      };
      page.on("requestfinished", finish);
      page.on("requestfailed", finish);
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
        if (contentType.includes("text/event-stream")) {
          inFlight.delete(req);
          return;
        }
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

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page, Request, Response, WebSocket } from "playwright";

export type ArtifactRef = {
  kind: "trace" | "screenshot" | "har" | "log" | "network" | "ws" | "sse";
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
  /** Real target: no screenshots/trace on disk, and network/WS/SSE logs drop bodies and query strings. */
  realTarget?: boolean;
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

export type WsFrame = {
  url: string;
  direction: "sent" | "received";
  size: number;
  payload: string;
  at: string;
};

export type SseEvent = {
  url: string;
  event?: string;
  data: string;
  at: string;
};

const WS_FRAME_LIMIT = 200;
const WS_PAYLOAD_LIMIT = 4000;
const SSE_EVENT_LIMIT = 200;
const SSE_DATA_LIMIT = 4000;
/** Finite SSE only: Playwright `body()` on endless streams is raced and dropped on timeout. */
const SSE_BODY_TIMEOUT_MS = 3_000;

function safeStepFileId(stepId: string): string {
  const sanitized = stepId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
  return sanitized.length > 0 ? sanitized : "step";
}

function stepScreenshotFileName(index: number, stepId: string): string {
  const nn = String(index).padStart(2, "0");
  return `step-${nn}-${safeStepFileId(stepId)}.png`;
}

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
  const wsFrames: WsFrame[] = [];
  let wsDropped = 0;
  const sseEvents: SseEvent[] = [];
  let sseDropped = 0;
  let sseDataTruncated = false;
  const ssePending: Promise<void>[] = [];
  const sseSeen = new Set<string>();
  const stepScreenshots: Array<{ stepId: string; file: string }> = [];
  const realTarget = options.realTarget === true;

  /** Real-target logs keep the endpoint shape but drop query strings (tokens often live there). */
  function realTargetUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`.slice(0, 500);
    } catch {
      return url.split("?")[0]!.slice(0, 500);
    }
  }

  function parseSseBlocks(text: string): Array<{ event?: string; data: string }> {
    const normalized = text.replace(/\r\n/g, "\n");
    const blocks = normalized.split("\n\n").filter((block) => block.trim().length > 0);
    const parsed: Array<{ event?: string; data: string }> = [];
    for (const block of blocks) {
      let event: string | undefined;
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const chunk = line.slice(5).trimStart();
          if (chunk.length > 0) dataLines.push(chunk);
        }
      }
      if (dataLines.length > 0 || event) {
        parsed.push({ event, data: dataLines.join("\n") });
      }
    }
    return parsed;
  }

  function recordSseEvent(url: string, event: string | undefined, data: string) {
    if (!event && data.trim().length === 0) return; // drop nameless heartbeats only
    const dedupeKey = `${url.slice(0, 2000)}\0${event ?? ""}\0${data}`;
    if (sseSeen.has(dedupeKey)) return;
    sseSeen.add(dedupeKey);
    if (sseEvents.length >= SSE_EVENT_LIMIT) {
      sseDropped += 1;
      return;
    }
    let text = data;
    if (text.length > SSE_DATA_LIMIT) {
      text = text.slice(0, SSE_DATA_LIMIT);
      sseDataTruncated = true;
    }
    sseEvents.push({
      url: url.slice(0, 2000),
      ...(event ? { event: event.slice(0, 200) } : {}),
      data: text,
      at: new Date().toISOString(),
    });
  }

  function recordSseFromBody(url: string, bodyText: string) {
    for (const block of parseSseBlocks(bodyText)) {
      recordSseEvent(url, block.event, block.data);
    }
  }

  function recordWsFrame(url: string, direction: WsFrame["direction"], raw: string | Buffer) {
    if (wsFrames.length >= WS_FRAME_LIMIT) {
      wsDropped += 1;
      return;
    }
    const binary = Buffer.isBuffer(raw);
    const size = binary ? raw.length : Buffer.byteLength(raw, "utf8");
    const text = binary ? `base64:${raw.toString("base64")}` : raw;
    wsFrames.push({
      url: url.slice(0, 2000),
      direction,
      size,
      payload: text.slice(0, WS_PAYLOAD_LIMIT),
      at: new Date().toISOString(),
    });
  }

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
    const redacted = network.map((n) => {
      if (realTarget) {
        return {
          url: realTargetUrl(n.url),
          method: n.method,
          ...(n.status !== undefined ? { status: n.status } : {}),
          resourceType: n.resourceType,
          ...(n.stepId ? { stepId: n.stepId } : {}),
        };
      }
      return redactForEvidence({
        ...n,
        url: redactUrl(n.url),
        requestBody: n.requestBody ? redactStringBody(n.requestBody) : undefined,
        responseBody: n.responseBody ? redactStringBody(n.responseBody) : undefined,
        requestHeaders: redactHeaders(n.requestHeaders),
        responseHeaders: redactHeaders(n.responseHeaders),
      });
    });
    await writeFile(path, JSON.stringify(redacted, null, 2));
    if (!artifacts.some((a) => a.kind === "network")) {
      artifacts.push({ kind: "network", path });
    }
  }

  async function writeSseLog() {
    await Promise.allSettled(ssePending);
    const path = join(runDir, "sse.json");
    const body: {
      limit: number;
      dropped: number;
      note?: string;
      events: SseEvent[];
    } = {
      limit: SSE_EVENT_LIMIT,
      dropped: sseDropped,
      events: sseEvents.map((evt) => ({
        ...evt,
        url: realTarget ? realTargetUrl(evt.url) : redactUrl(evt.url),
        data: realTarget ? "" : redactStringBody(evt.data),
      })),
    };
    const notes: string[] = [];
    if (realTarget) notes.push("real target: SSE payloads omitted");
    if (sseDataTruncated) {
      notes.push(`some event data truncated to ${SSE_DATA_LIMIT} characters`);
    }
    if (sseDropped > 0) {
      notes.push(`dropped ${sseDropped} sse events beyond the limit of ${SSE_EVENT_LIMIT}`);
    }
    if (notes.length > 0) body.note = notes.join("; ");
    await writeFile(path, JSON.stringify(body, null, 2));
    if (!artifacts.some((a) => a.kind === "sse")) {
      artifacts.push({ kind: "sse", path });
    }
  }

  async function writeWsLog() {
    const path = join(runDir, "ws.json");
    const body: {
      limit: number;
      dropped: number;
      note?: string;
      frames: WsFrame[];
    } = {
      limit: WS_FRAME_LIMIT,
      dropped: wsDropped,
      frames: wsFrames.map((frame) => ({
        ...frame,
        url: realTarget ? realTargetUrl(frame.url) : redactUrl(frame.url),
        payload: realTarget ? "" : redactStringBody(frame.payload),
      })),
    };
    if (realTarget) {
      body.note = "real target: WebSocket payloads omitted";
    } else if (wsDropped > 0) {
      body.note = `dropped ${wsDropped} websocket frames beyond the limit of ${WS_FRAME_LIMIT}`;
    }
    await writeFile(path, JSON.stringify(body, null, 2));
    if (!artifacts.some((a) => a.kind === "ws")) {
      artifacts.push({ kind: "ws", path });
    }
  }

  return {
    getNetworkLog(): NetworkEntry[] {
      return [...network];
    },

    getWebSocketFrames(): WsFrame[] {
      return [...wsFrames];
    },

    getSseEvents(): SseEvent[] {
      return [...sseEvents];
    },

    async waitForSseEvent(
      predicate: (event: SseEvent) => boolean,
      timeoutMs = 10_000,
    ): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (sseEvents.some(predicate)) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },

    async waitForWebSocketFrame(
      predicate: (frame: WsFrame) => boolean,
      timeoutMs = 10_000,
    ): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (wsFrames.some(predicate)) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
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
      // Trace snapshots capture DOM and page content; real targets keep no trace by default.
      if (!realTarget) {
        await ctx.tracing.start({ screenshots: true, snapshots: true, sources: true });
      }
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Network.enable");
      const sseRequestUrls = new Map<string, string>();
      cdp.on("Network.responseReceived", (params) => {
        const mime = params.response.mimeType?.toLowerCase() ?? "";
        if (!mime.includes("event-stream")) return;
        sseRequestUrls.set(params.requestId, params.response.url);
      });
      cdp.on("Network.eventSourceMessageReceived", (params) => {
        const url = sseRequestUrls.get(params.requestId);
        if (!url) return;
        const rawName = params.eventName?.trim();
        const eventName = rawName && rawName !== "message" ? rawName : undefined;
        recordSseEvent(url, eventName, params.data ?? "");
      });
      cdp.on("Network.loadingFinished", (params) => {
        const url = sseRequestUrls.get(params.requestId);
        if (!url) return;
        ssePending.push(
          (async () => {
            try {
              const payload = (await cdp.send("Network.getResponseBody", {
                requestId: params.requestId,
              })) as { body: string; base64Encoded: boolean };
              const text = payload.base64Encoded
                ? Buffer.from(payload.body, "base64").toString("utf8")
                : payload.body;
              recordSseFromBody(url, text);
            } catch {
              /* infinite streams may never finish or reject body reads */
            }
          })(),
        );
      });
      page.on("request", (req: Request) => {
        const type = req.resourceType();
        if (type === "xhr" || type === "fetch" || type === "document") inFlight.add(req);
      });
      const finish = (req: Request) => {
        inFlight.delete(req);
      };
      page.on("requestfinished", finish);
      page.on("requestfailed", finish);
      page.on("websocket", (socket: WebSocket) => {
        const url = socket.url();
        socket.on("framesent", (event) => recordWsFrame(url, "sent", event.payload));
        socket.on("framereceived", (event) => recordWsFrame(url, "received", event.payload));
      });
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
          if (req.resourceType() !== "eventsource") {
            const streamUrl = req.url();
            ssePending.push(
              (async () => {
                try {
                  await Promise.race([
                    res.finished(),
                    new Promise<void>((resolve) => setTimeout(resolve, SSE_BODY_TIMEOUT_MS)),
                  ]);
                } catch {
                  return;
                }
                const base = streamUrl.split("?")[0];
                if (
                  sseEvents.some(
                    (evt) => evt.url === streamUrl || evt.url.split("?")[0] === base,
                  )
                ) {
                  return;
                }
                try {
                  const buffer = await Promise.race([
                    res.body(),
                    new Promise<never>((_, reject) =>
                      setTimeout(() => reject(new Error("sse-body-timeout")), SSE_BODY_TIMEOUT_MS),
                    ),
                  ]);
                  recordSseFromBody(streamUrl, buffer.toString("utf8"));
                } catch {
                  /* infinite or aborted SSE streams are intentionally not captured */
                }
              })(),
            );
          }
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
      if (options.screenshots === "never" || realTarget) return;
      const file = join(runDir, `failure-${label}.png`);
      await page.screenshot({ path: file, fullPage: true });
      artifacts.push({ kind: "screenshot", path: file });
      await writeNetworkLog();
    },

    async captureStep(page: Page, stepId: string, index: number): Promise<string | undefined> {
      if (options.screenshots !== "always" || realTarget) return undefined;
      const fileName = stepScreenshotFileName(index, stepId);
      try {
        await mkdir(runDir, { recursive: true });
        await page.screenshot({ path: join(runDir, fileName), fullPage: true });
      } catch {
        // Evidence capture must not turn a passing step into a failed run.
        return undefined;
      }
      artifacts.push({ kind: "screenshot", path: join(runDir, fileName) });
      stepScreenshots.push({ stepId, file: fileName });
      return fileName;
    },

    async finalize(status: string): Promise<RunArtifacts> {
      await mkdir(runDir, { recursive: true });
      await writeNetworkLog();
      await writeWsLog();
      await writeSseLog();
      if (context && !realTarget) {
        const tracePath = join(runDir, "trace.zip");
        await context.tracing.stop({ path: tracePath });
        artifacts.push({ kind: "trace", path: tracePath });
      }
      const manifest = {
        runId: options.runId,
        status,
        ...(realTarget ? { privacy: "real-target: no screenshots/trace; network/WS/SSE payloads omitted" } : {}),
        artifacts,
        stepScreenshots,
      };
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

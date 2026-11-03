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
};

export function createEvidenceCollector(options: EvidenceOptions) {
  const runDir = join(options.dir, options.runId);
  const artifacts: ArtifactRef[] = [];
  let context: BrowserContext | undefined;
  const network: NetworkEntry[] = [];

  async function writeNetworkLog() {
    const path = join(runDir, "network.json");
    const redacted = network.map((n) => ({
      ...n,
      url: n.url.replace(/([?&]token=)[^&]+/gi, "$1***"),
    }));
    await writeFile(path, JSON.stringify(redacted, null, 2));
    if (!artifacts.some((a) => a.kind === "network")) {
      artifacts.push({ kind: "network", path });
    }
  }

  return {
    getNetworkLog(): NetworkEntry[] {
      return [...network];
    },

    async attachPage(ctx: BrowserContext, page: Page) {
      context = ctx;
      await mkdir(runDir, { recursive: true });
      await ctx.tracing.start({ screenshots: true, snapshots: true, sources: true });
      page.on("response", (res: Response) => {
        const req = res.request();
        if (network.length > 200) return;
        network.push({
          url: req.url().slice(0, 500),
          method: req.method(),
          status: res.status(),
          resourceType: req.resourceType(),
        });
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

export function classifyFailure(input: FailureClassifierInput): string {
  if (input.stepError?.includes("timeout") || input.httpStatus === 503) {
    return "ENVIRONMENT";
  }
  if (input.stepError?.includes("net::") || input.stepError?.includes("ERR_")) {
    return "ENVIRONMENT";
  }
  if (input.stepError?.includes("locator") || input.stepError?.includes("strict mode")) {
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

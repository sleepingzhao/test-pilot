import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { registerRoutes } from "./routes.js";
import { FileStore } from "./store.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const reportPath = join(repoRoot, "artifacts/negative-probes-last.json");

test("metrics summary exposes negative probe report when present", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-neg-probes-"));
  const dataRoot = join(root, "data");
  const store = new FileStore(dataRoot);
  await store.init();

  await mkdir(join(repoRoot, "artifacts"), { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify({
      completedAt: "2026-11-04T00:00:00.000Z",
      ok: true,
      probes: [
        {
          id: "probe-playwright-ui",
          provider: "playwright-ui",
          ok: true,
          file: "x.json",
          actualStatus: "failed",
          failedAssertionIds: ["a"],
        },
      ],
    }),
  );

  const app = Fastify();
  await app.register(sensible);
  registerRoutes(app, store, join(root, "artifacts"), dataRoot);
  await app.ready();

  try {
    const summary = await app.inject({ method: "GET", url: "/api/metrics/summary" });
    assert.equal(summary.statusCode, 200);
    const body = summary.json() as { negativeProbes?: { ok: boolean } };
    assert.equal(body.negativeProbes?.ok, true);

    const direct = await app.inject({ method: "GET", url: "/api/metrics/negative-probes" });
    assert.equal(direct.statusCode, 200);
    const probeBody = direct.json() as { ok: boolean };
    assert.equal(probeBody.ok, true);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
    await unlink(reportPath).catch(() => undefined);
  }
});

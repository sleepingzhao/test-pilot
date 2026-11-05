import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import sensible from "@fastify/sensible";
import { computeIRHash } from "@testpilot/test-ir";
import { computeAssertionConfigHash } from "@testpilot/fixtures";
import Fastify from "fastify";
import { registerRoutes } from "./routes.js";
import { FileStore } from "./store.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key];
    const next = vars[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  return fn().finally(() => {
    for (const key of Object.keys(vars)) {
      const next = prev[key];
      if (next === undefined) delete process.env[key];
      else process.env[key] = next;
    }
  });
}

test("approve writes audit log and enforces approval token + actor allow-list", async () => {
  await withEnv(
    {
      TESTPILOT_APPROVAL_TOKEN: "approve-secret",
      TESTPILOT_APPROVAL_ACTORS: "qa-lead,qa-bot",
    },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "testpilot-p5-"));
      const dataRoot = join(root, "data");
      const store = new FileStore(dataRoot);
      await store.init();

      const testId = "p5-audit";
      const ir = {
        id: testId,
        version: 1,
        platform: "web" as const,
        steps: [{ id: "open", action: "navigate" as const, path: "/" }],
        assertions: [
          { id: "ok", type: "ui" as const, contains: "saved", oracle: "human-approved" as const },
        ],
      };
      await store.saveTest({
        id: testId,
        projectId: "default",
        title: "audit me",
        ir,
        approvalStatus: "draft",
        updatedAt: new Date().toISOString(),
      });

      const app = Fastify();
      await app.register(sensible);
      registerRoutes(app, store, join(root, "artifacts"), dataRoot);
      await app.ready();

      try {
        const hash = computeIRHash(ir);
        const configHash = computeAssertionConfigHash(repoRoot);

        const missingToken = await app.inject({
          method: "POST",
          url: `/api/tests/${testId}/approve`,
          payload: { irHash: hash, assertionConfigHash: configHash },
          headers: { "x-testpilot-actor": "qa-bot" },
        });
        assert.equal(missingToken.statusCode, 401);

        const wrongActor = await app.inject({
          method: "POST",
          url: `/api/tests/${testId}/approve`,
          payload: { irHash: hash, assertionConfigHash: configHash },
          headers: {
            "x-testpilot-actor": "intern",
            "x-testpilot-approval-token": "approve-secret",
          },
        });
        assert.equal(wrongActor.statusCode, 403);

        const ok = await app.inject({
          method: "POST",
          url: `/api/tests/${testId}/approve`,
          payload: { irHash: hash, assertionConfigHash: configHash },
          headers: {
            "x-testpilot-actor": "qa-lead",
            "x-testpilot-approval-token": "approve-secret",
          },
        });
        assert.equal(ok.statusCode, 200);
        assert.equal((ok.json() as { approvedBy?: string }).approvedBy, "qa-lead");

        const auditRes = await app.inject({ method: "GET", url: "/api/audit?limit=5" });
        assert.equal(auditRes.statusCode, 200);
        const entries = (auditRes.json() as { entries: Array<{ testId: string; actor: string }> }).entries;
        assert.equal(entries[0]?.testId, testId);
        assert.equal(entries[0]?.actor, "qa-lead");

        const raw = await readFile(join(dataRoot, "audit.jsonl"), "utf8");
        assert.match(raw, /test\.approve/);
      } finally {
        await app.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

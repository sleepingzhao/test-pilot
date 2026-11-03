import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FileStore } from "./store.js";
import type { StoredTest } from "./store.js";
import { computeIRHash } from "@testpilot/test-ir";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const catalogPath = join(dirname(fileURLToPath(import.meta.url)), "seed-catalog.json");
const pilotCatalogPath = join(dirname(fileURLToPath(import.meta.url)), "seed-pilot-catalog.json");

async function syncCatalogFromFile(
  store: FileStore,
  catalogFile: string,
  opts?: { loginDraftWithoutSecrets?: boolean; pilotCatalog?: boolean },
): Promise<number> {
  const catalog = JSON.parse(await readFile(catalogFile, "utf8")) as Array<{ file: string; title: string }>;
  const pilotCatalog = opts?.pilotCatalog ?? catalogFile.includes("pilot-catalog");
  let count = 0;
  for (const spec of catalog) {
    const path = join(repoRoot, spec.file);
    try {
      const ir = JSON.parse(await readFile(path, "utf8"));
      const prev = await store.getTest(ir.id);
      const needsSecrets = ir.steps?.some((s: { valueRef?: string }) => s.valueRef?.startsWith("env."));
      const secretMissing = needsSecrets && !process.env.TESTPILOT_ENV_ADMIN_PHONE;
      const placeholderAssert = ir.assertions?.some((a: { contains?: string }) =>
        String(a.contains ?? "").includes("REPLACE"),
      );
      const isAutoIntake = String(ir.id).startsWith("pilot-auto-");
      const isPilot = pilotCatalog || isAutoIntake || spec.title.includes("【试点】");

      let approvalStatus: StoredTest["approvalStatus"];
      if (isPilot && !prev?.approvedAt) {
        approvalStatus = "draft";
      } else if (prev?.approvalStatus) {
        approvalStatus = prev.approvalStatus;
      } else if (placeholderAssert || (secretMissing && opts?.loginDraftWithoutSecrets)) {
        approvalStatus = "draft";
      } else if (isPilot) {
        approvalStatus = "draft";
      } else {
        approvalStatus = "approved";
      }

      const test: StoredTest = {
        id: ir.id,
        projectId: "default",
        title: spec.title,
        ir,
        irHash: computeIRHash(ir),
        approvalStatus,
        approvedAt: prev?.approvedAt,
        intentSummary: prev?.intentSummary,
        sourceChannel: prev?.sourceChannel,
        plannerNotes: prev?.plannerNotes,
        updatedAt: new Date().toISOString(),
      };
      await store.saveTest(test);
      count += 1;
    } catch {
      /* skip */
    }
  }
  return count;
}

export async function seedIfEmpty(store: FileStore): Promise<number> {
  const existing = await store.listTests();
  if (existing.length > 0) return 0;

  let count = 0;
  count += await syncCatalogFromFile(store, catalogPath);
  count += await syncCatalogFromFile(store, pilotCatalogPath, {
    loginDraftWithoutSecrets: true,
    pilotCatalog: true,
  });
  return count;
}

/** Re-sync demo tests from catalog (keeps ids stable). */
export async function syncCatalogTests(store: FileStore): Promise<number> {
  return syncCatalogFromFile(store, catalogPath);
}

export async function syncPilotCatalogTests(store: FileStore): Promise<number> {
  return syncCatalogFromFile(store, pilotCatalogPath, { loginDraftWithoutSecrets: true, pilotCatalog: true });
}

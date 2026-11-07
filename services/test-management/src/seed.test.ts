import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { computeIRHash, IR_HASH_VERSION, type TestIR } from "@testpilot/test-ir";
import { seedIfEmpty, syncCatalogFromFile, syncPilotCatalogTests } from "./seed.js";
import { FileStore, type StoredTest } from "./store.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureFile = "packages/test-ir/fixtures/user-create-duplicate-email.json";
const fixtureIR = JSON.parse(readFileSync(join(repoRoot, fixtureFile), "utf8")) as TestIR;

async function syncWithPrevious(previous: StoredTest | null): Promise<StoredTest | undefined> {
  const root = await mkdtemp(join(tmpdir(), "testpilot-seed-"));
  const store = new FileStore(join(root, "data"));
  await store.init();
  if (previous) await store.saveTest(previous);
  const catalog = join(root, "catalog.json");
  await writeFile(catalog, JSON.stringify([{ file: fixtureFile, title: "【试点】catalog" }]));
  try {
    await syncCatalogFromFile(store, catalog);
    return await store.getTest(fixtureIR.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function previousTest(overrides: Partial<StoredTest>): StoredTest {
  return {
    id: fixtureIR.id,
    projectId: "default",
    title: "【试点】catalog",
    ir: fixtureIR,
    approvalStatus: "approved",
    approvedAt: "2026-01-01T00:00:00.000Z",
    approvedBy: "qa",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("catalog sync migrates old hashes without dropping approval", async () => {
  const saved = await syncWithPrevious(previousTest({ irHash: "legacy" }));
  assert.equal(saved?.approvalStatus, "approved");
  assert.equal(saved?.approvedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(saved?.irHashVersion, IR_HASH_VERSION);
});

test("changing a reviewed pilot IR resets it to draft", async () => {
  const saved = await syncWithPrevious(
    previousTest({ irHash: "previous-version", irHashVersion: IR_HASH_VERSION }),
  );
  assert.equal(saved?.approvalStatus, "draft");
  assert.equal(saved?.approvedAt, undefined);
  assert.equal(saved?.approvedBy, undefined);
});

test("unchanged versioned pilot IR keeps approval", async () => {
  const saved = await syncWithPrevious(
    previousTest({ irHash: computeIRHash(fixtureIR), irHashVersion: IR_HASH_VERSION }),
  );
  assert.equal(saved?.approvalStatus, "approved");
  assert.equal(saved?.approvedBy, "qa");
});

test("draft catalog tests do not keep stale approval metadata", async () => {
  const saved = await syncWithPrevious(
    previousTest({
      approvalStatus: "draft",
      irHash: computeIRHash(fixtureIR),
      irHashVersion: IR_HASH_VERSION,
    }),
  );
  assert.equal(saved?.approvalStatus, "draft");
  assert.equal(saved?.approvedAt, undefined);
  assert.equal(saved?.approvedBy, undefined);
});

test("shipped pilot catalog is empty so pilot tests are not auto-seeded", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-pilot-empty-"));
  const store = new FileStore(join(root, "data"));
  await store.init();
  try {
    await seedIfEmpty(store);
    await syncPilotCatalogTests(store);
    const pilots = (await store.listTests()).filter((t) => t.id.startsWith("pilot-"));
    assert.deepEqual(pilots.map((t) => t.id), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pilot catalog sync still loads a listed pilot test as draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-pilot-seed-"));
  const store = new FileStore(join(root, "data"));
  await store.init();
  const catalog = join(root, "pilot-catalog.json");
  await writeFile(
    catalog,
    JSON.stringify([
      { file: "examples/pilot-admin/tests/pilot-ticket-no-region.json", title: "【试点】catalog" },
    ]),
  );
  try {
    await syncCatalogFromFile(store, catalog, { pilotCatalog: true });
    const saved = await store.getTest("pilot-ticket-no-region");
    assert.ok(saved, "pilot-ticket-no-region should be in store after sync");
    assert.equal(saved.approvalStatus, "draft");
    assert.ok(saved.ir.steps.some((s) => s.id === "wait-region-alert"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rebuilt hash keeps approval when the approved IR content is unchanged", async () => {
  const saved = await syncWithPrevious(
    previousTest({
      irHash: "hash-from-old-algorithm",
      irHashVersion: IR_HASH_VERSION,
      approvedIr: fixtureIR,
    }),
  );
  assert.equal(saved?.approvalStatus, "approved");
  assert.equal(saved?.approvedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(saved?.irHash, computeIRHash(fixtureIR));
});

test("changed IR content still drops the pilot approval", async () => {
  const changed = { ...fixtureIR, steps: [...fixtureIR.steps, { id: "extra", action: "wait" as const }] };
  const saved = await syncWithPrevious(
    previousTest({
      irHash: "hash-from-old-algorithm",
      irHashVersion: IR_HASH_VERSION,
      approvedIr: changed,
    }),
  );
  assert.equal(saved?.approvalStatus, "draft");
});

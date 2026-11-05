import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { computeAssertionConfigHash, invalidateAssertionConfigCache } from "./config-hash.js";
import { getDbConfigBundle, loadAssertionDbConfigs } from "./db-config.js";

async function writeDbConfig(root: string, version: number) {
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(
    join(root, "docs", "assertion-db-config.json"),
    JSON.stringify({
      version,
      dbs: {
        "pilot-db": {
          connectionRef: "env.PILOT_DB_URL",
          allowedTables: ["work_order"],
          queries: { "order-by-run-id": `SELECT id FROM work_order WHERE ref = :runId AND v = ${version}` },
        },
      },
    }),
  );
}

test("computeAssertionConfigHash differs when config changes and stays stable otherwise", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-config-hash-"));
  try {
    await writeDbConfig(root, 1);
    invalidateAssertionConfigCache();
    const h1 = computeAssertionConfigHash(root);
    const h1b = computeAssertionConfigHash(root);
    assert.equal(h1, h1b);

    await writeDbConfig(root, 2);
    invalidateAssertionConfigCache();
    const h2 = computeAssertionConfigHash(root);
    assert.notEqual(h1, h2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadAssertionDbConfigs reloads when config hash changes (no stale cache)", async () => {
  const root = await mkdtemp(join(tmpdir(), "testpilot-config-load-"));
  try {
    await writeDbConfig(root, 1);
    invalidateAssertionConfigCache();
    const first = getDbConfigBundle("pilot-db", root);
    assert.match(first?.queries["order-by-run-id"] ?? "", /v = 1/);

    await writeDbConfig(root, 2);
    invalidateAssertionConfigCache();
    const second = getDbConfigBundle("pilot-db", root);
    assert.match(second?.queries["order-by-run-id"] ?? "", /v = 2/);

    const cached = loadAssertionDbConfigs(root);
    assert.match(cached["pilot-db"]?.queries["order-by-run-id"] ?? "", /v = 2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

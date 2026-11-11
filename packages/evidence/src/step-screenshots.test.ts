import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Page } from "playwright";
import { createEvidenceCollector } from "./index.js";

function fakePage(writes: string[]): Page {
  return {
    screenshot: async ({ path }: { path?: string }) => {
      if (path) {
        writes.push(path);
        const { writeFile, mkdir } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "png-bytes");
      }
    },
  } as unknown as Page;
}

test("captureStep respects screenshot policy and writes step files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "testpilot-evidence-step-"));
  const writes: string[] = [];
  const page = fakePage(writes);

  const neverCol = createEvidenceCollector({ runId: "never-run", dir, screenshots: "never" });
  assert.equal(await neverCol.captureStep(page, "open", 1), undefined);
  assert.equal(writes.length, 0);

  const onFailCol = createEvidenceCollector({ runId: "onfail-run", dir, screenshots: "on-failure" });
  assert.equal(await onFailCol.captureStep(page, "open", 1), undefined);
  assert.equal(writes.length, 0);

  const runId = "always-run";
  const alwaysCol = createEvidenceCollector({ runId, dir, screenshots: "always" });
  const file = await alwaysCol.captureStep(page, "open", 1);
  assert.equal(file, "step-01-open.png");
  assert.equal(writes.length, 1);
  assert.equal(writes[0], join(dir, runId, "step-01-open.png"));

  const hostile = await alwaysCol.captureStep(page, "../x y", 2);
  assert.equal(hostile, "step-02----x-y.png");
  assert.ok(!hostile!.includes("/"));
  assert.ok(!hostile!.includes(".."));
  const hostilePath = join(dir, runId, hostile!);
  assert.equal(hostilePath.startsWith(join(dir, runId) + "/") || hostilePath.startsWith(join(dir, runId) + "\\"), true);

  await alwaysCol.finalize("passed");
  const manifest = JSON.parse(await readFile(join(dir, runId, "manifest.json"), "utf8")) as {
    stepScreenshots: Array<{ stepId: string; file: string }>;
  };
  assert.equal(manifest.stepScreenshots.length, 2);
  assert.deepEqual(manifest.stepScreenshots[0], { stepId: "open", file: "step-01-open.png" });
  assert.deepEqual(manifest.stepScreenshots[1], { stepId: "../x y", file: "step-02----x-y.png" });

  await access(join(dir, runId, "step-01-open.png"));
  await access(join(dir, runId, "step-02----x-y.png"));
});

test("finalize includes empty stepScreenshots when none captured", async () => {
  const dir = await mkdtemp(join(tmpdir(), "testpilot-evidence-step-"));
  const col = createEvidenceCollector({ runId: "empty", dir, screenshots: "on-failure" });
  await col.finalize("passed");
  const manifest = JSON.parse(await readFile(join(dir, "empty", "manifest.json"), "utf8")) as {
    stepScreenshots: unknown[];
  };
  assert.deepEqual(manifest.stepScreenshots, []);
});

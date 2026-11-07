import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactFileName,
  formatJsonBrief,
  listEvidenceRows,
  runDetailHeadline,
} from "../../../apps/console/src/runDetail.js";
import type { StoredRun } from "../../../apps/console/src/api.js";

function run(partial: Partial<StoredRun> = {}): StoredRun {
  return {
    runId: "run_1",
    testId: "t",
    testTitle: "demo",
    status: "failed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    steps: [],
    assertions: [],
    artifacts: {
      dir: "artifacts/runs/run_1",
      artifacts: [
        { kind: "trace", path: "/artifacts/runs/run_1/trace.zip" },
        { kind: "network", path: "/artifacts/runs/run_1/network.json" },
        { kind: "screenshot", path: "/artifacts/runs/run_1/failure.png" },
        { kind: "log", path: "/artifacts/runs/run_1/manifest.json" },
      ],
    },
    metrics: { durationMs: 1000, llmTokensUsed: 0, attemptCount: 1 },
    ...partial,
  };
}

test("artifact names are reduced to a safe final segment", () => {
  assert.equal(artifactFileName(run(), "trace"), "trace.zip");
  assert.equal(artifactFileName(run({ artifacts: { dir: "", artifacts: [] } }), "trace"), null);
});

test("missing artifact entries render no link (negative)", () => {
  const rows = listEvidenceRows(
    run({ artifacts: { dir: "artifacts/runs/run_1", artifacts: [] } }),
  );
  assert.equal(rows.find((r) => r.label === "Trace")?.href, null);
  assert.equal(rows.find((r) => r.label === "Network")?.href, null);
});

test("artifactsPresent=false hides a cleaned artifact instead of linking it (negative)", () => {
  const rows = listEvidenceRows(
    run({
      artifactsPresent: { trace: false, network: true, screenshot: false, log: true },
    }),
  );
  assert.equal(rows.find((r) => r.label === "Trace")?.href, null);
  assert.equal(rows.find((r) => r.label === "截图")?.href, null);
  assert.match(rows.find((r) => r.label === "Network")?.href ?? "", /network\.json$/);
  assert.match(rows.find((r) => r.label === "运行清单")?.href ?? "", /manifest\.json$/);
});

test("runDetailHeadline reports attempts and failure kind", () => {
  const text = runDetailHeadline(
    run({ status: "failed", metrics: { durationMs: 1200, llmTokensUsed: 0, attemptCount: 2, failureKind: "ENVIRONMENT" } }),
  );
  assert.match(text, /失败/);
  assert.match(text, /2 次尝试/);
  assert.match(text, /环境异常/);
});

test("formatJsonBrief truncates long values and tolerates undefined", () => {
  assert.equal(formatJsonBrief(undefined), "—");
  assert.ok(formatJsonBrief({ a: "x".repeat(1000) }, 40).endsWith("…"));
});

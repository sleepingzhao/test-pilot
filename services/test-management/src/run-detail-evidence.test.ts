/**
 * Mirror of console runDetail evidence rules — missing artifacts must not produce URLs.
 */
import assert from "node:assert/strict";
import test from "node:test";

type RunLike = {
  runId: string;
  artifacts: { artifacts: Array<{ kind: string; path: string }> };
};

function artifactFileName(run: RunLike, kind: string): string | null {
  const entry = run.artifacts.artifacts.find((a) => a.kind === kind);
  if (!entry?.path) return null;
  return entry.path.split(/[/\\]/).pop() ?? null;
}

test("missing trace shows no artifact file (negative)", () => {
  const run: RunLike = { runId: "r1", artifacts: { artifacts: [{ kind: "network", path: "/x/network.json" }] } };
  assert.equal(artifactFileName(run, "trace"), null);
});

test("trace artifact resolves to safe file name (positive)", () => {
  const run: RunLike = {
    runId: "r1",
    artifacts: { artifacts: [{ kind: "trace", path: "/artifacts/runs/r1/trace.zip" }] },
  };
  assert.equal(artifactFileName(run, "trace"), "trace.zip");
});

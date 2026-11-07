import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency, maxParallelFromEnv } from "./batch-parallel.js";

test("maxParallelFromEnv defaults to 2 and clamps to 4", () => {
  const prev = process.env.TESTPILOT_MAX_PARALLEL;
  try {
    delete process.env.TESTPILOT_MAX_PARALLEL;
    assert.equal(maxParallelFromEnv(), 2);
    process.env.TESTPILOT_MAX_PARALLEL = "9";
    assert.equal(maxParallelFromEnv(), 4);
    process.env.TESTPILOT_MAX_PARALLEL = "0";
    assert.equal(maxParallelFromEnv(), 1);
  } finally {
    if (prev === undefined) delete process.env.TESTPILOT_MAX_PARALLEL;
    else process.env.TESTPILOT_MAX_PARALLEL = prev;
  }
});

test("mapWithConcurrency limits in-flight work", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = [0, 1, 2, 3, 4];

  const results = await mapWithConcurrency(items, 2, async (n) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return n * 10;
  });

  assert.ok(maxInFlight <= 2);
  assert.deepEqual(results, [0, 10, 20, 30, 40]);
});

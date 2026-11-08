import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEvidenceCollector } from "./index.js";

test("direct request entries are truncated, redacted, and visible to waitForNetworkEntry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "testpilot-evidence-"));
  const evidence = createEvidenceCollector({ runId: "direct", dir, screenshots: "never" });
  const token = "Bearer sekret-v7-evidence";
  const waiting = evidence.waitForNetworkEntry((entry) => entry.url.includes("/api/users"), 2_000);
  await new Promise((resolve) => setTimeout(resolve, 30));
  evidence.recordNetworkEntry({
    url: "http://127.0.0.1:4173/api/users",
    method: "POST",
    status: 201,
    requestHeaders: { authorization: token, cookie: "session=abc", "content-type": "application/json" },
    requestBody: JSON.stringify({ email: "created@example.com" }),
    responseHeaders: { "content-type": "application/json", "set-cookie": "session=abc" },
    responseBody: JSON.stringify({ ok: true, email: "created@example.com", note: "x".repeat(5000) }),
  });
  evidence.recordNetworkEntry({
    url: "http://127.0.0.1:4173/api/huge",
    method: "POST",
    status: 200,
    responseBody: "y".repeat(9000),
  });
  assert.equal(await waiting, true);

  const log = evidence.getNetworkLog();
  assert.equal(log[0]?.status, 201);
  assert.equal(log[0]?.requestHeaders?.authorization, token);
  assert.equal(log[0]?.responseBody?.length, 4000);
  assert.equal(log[1]?.responseBody, undefined);

  await evidence.finalize("passed");
  const written = await readFile(join(dir, "direct", "network.json"), "utf8");
  assert.match(written, /"authorization": "\*\*\*"/);
  assert.match(written, /"cookie": "\*\*\*"/);
  assert.match(written, /"set-cookie": "\*\*\*"/);
  assert.doesNotMatch(written, /sekret-v7-evidence/);
  assert.doesNotMatch(written, /session=abc/);
  assert.doesNotMatch(written, /created@example\.com/);
});

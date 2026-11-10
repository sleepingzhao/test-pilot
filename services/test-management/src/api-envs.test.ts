import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import {
  loadApiEnvs,
  mergeApiEnvHeaders,
  parseApiEnvsArray,
  publicApiEnvs,
} from "./api-envs.js";

const ENV_KEY = "TESTPILOT_API_ENVS_FILE";

let previousFile: string | undefined;

afterEach(() => {
  if (previousFile === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = previousFile;
});

async function withConfig(entries: unknown[], fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "testpilot-api-envs-"));
  const file = join(dir, "api-envs.json");
  await writeFile(file, JSON.stringify(entries), "utf8");
  previousFile = process.env[ENV_KEY];
  process.env[ENV_KEY] = file;
  try {
    await fn();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("parseApiEnvsArray accepts valid entries", () => {
  const res = parseApiEnvsArray([
    {
      id: "staging-api",
      label: "Staging",
      baseUrl: "https://api.staging.example",
      headers: { Authorization: "Bearer {{env.stagingToken}}" },
      allowWrite: false,
    },
  ]);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.envs.length, 1);
  assert.equal(res.envs[0]?.allowWrite, false);
});

test("loadApiEnvs returns [] when file is missing", async () => {
  previousFile = process.env[ENV_KEY];
  process.env[ENV_KEY] = join(tmpdir(), "missing-api-envs.json");
  assert.deepEqual(await loadApiEnvs(), []);
});

test("parseApiEnvsArray rejects duplicate id", () => {
  const res = parseApiEnvsArray([
    { id: "dup", label: "A", baseUrl: "https://a.example" },
    { id: "dup", label: "B", baseUrl: "https://b.example" },
  ]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.errors.join("; "), /重复/);
});

test("parseApiEnvsArray rejects bad baseUrl", () => {
  const res = parseApiEnvsArray([{ id: "x", label: "X", baseUrl: "ftp://bad.example" }]);
  assert.equal(res.ok, false);
});

test("parseApiEnvsArray rejects CRLF in header value", () => {
  const res = parseApiEnvsArray([
    {
      id: "x",
      label: "X",
      baseUrl: "https://x.example",
      headers: { "X-Test": "a\r\nb" },
    },
  ]);
  assert.equal(res.ok, false);
});

test("parseApiEnvsArray rejects forbidden header", () => {
  const res = parseApiEnvsArray([
    {
      id: "x",
      label: "X",
      baseUrl: "https://x.example",
      headers: { host: "evil" },
    },
  ]);
  assert.equal(res.ok, false);
});

test("parseApiEnvsArray rejects non-boolean allowWrite", () => {
  const res = parseApiEnvsArray([
    { id: "x", label: "X", baseUrl: "https://x.example", allowWrite: "yes" },
  ]);
  assert.equal(res.ok, false);
});

test("loadApiEnvs and publicApiEnvs hide header values", async () => {
  await withConfig(
    [
      {
        id: "local-ro",
        label: "Local read-only",
        baseUrl: "http://127.0.0.1:4173",
        headers: {
          Authorization: "Bearer {{env.stagingToken}}",
          "X-Custom": "static",
        },
        allowWrite: false,
      },
    ],
    async () => {
      const envs = await loadApiEnvs();
      assert.equal(envs.length, 1);
      assert.equal(envs[0]?.headers.Authorization, "Bearer {{env.stagingToken}}");

      const pub = await publicApiEnvs();
      assert.equal(pub.length, 1);
      assert.deepEqual(pub[0]?.headerNames, ["Authorization", "X-Custom"]);
      assert.equal((pub[0] as Record<string, unknown>).headers, undefined);
    },
  );
});

test("mergeApiEnvHeaders is case-insensitive and user headers win", () => {
  const merged = mergeApiEnvHeaders(
    { Authorization: "Bearer {{env.a}}", "X-Trace": "env" },
    { authorization: "Bearer user", "X-Extra": "1" },
  );
  assert.equal(merged.Authorization, undefined);
  assert.equal(merged.authorization, "Bearer user");
  assert.equal(merged["X-Trace"], "env");
  assert.equal(merged["X-Extra"], "1");
});

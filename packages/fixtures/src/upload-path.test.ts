import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveUploadFixtureDir, resolveUploadFixturePath, resolveValueRefEnvKey, type RunEnvironment } from "./index.js";

const SENTINEL = "SENTINEL_DO_NOT_READ_7f3a";

async function layout(): Promise<{ parent: string; fixtureDir: string; secret: string; env: RunEnvironment }> {
  const parent = await mkdtemp(join(tmpdir(), "tp-upload-fix-"));
  const fixtureDir = join(parent, "fixtures");
  await mkdir(fixtureDir);
  const secret = join(parent, "secret.txt");
  await writeFile(secret, SENTINEL);
  await writeFile(join(fixtureDir, "sample.txt"), "hello-upload");
  await mkdir(join(fixtureDir, "subdir"));
  return { parent, fixtureDir, secret, env: { baseUrl: "http://127.0.0.1", fixtureDir } };
}

test("resolveUploadFixtureDir defaults to examples/fixtures", () => {
  const prev = process.env.TESTPILOT_FIXTURE_DIR;
  delete process.env.TESTPILOT_FIXTURE_DIR;
  try {
    const dir = resolveUploadFixtureDir({ baseUrl: "http://127.0.0.1" });
    assert.equal(dir.endsWith(`${join("examples", "fixtures")}`), true);
  } finally {
    if (prev === undefined) delete process.env.TESTPILOT_FIXTURE_DIR;
    else process.env.TESTPILOT_FIXTURE_DIR = prev;
  }
});

test("resolves a valueRef to a file inside the fixture dir and ignores paths in the caller", async () => {
  const { parent, fixtureDir, env } = await layout();
  const prev = process.env.TESTPILOT_FIXTURE_DIR;
  process.env.TESTPILOT_FIXTURE_DIR = join(parent, "wrong");
  try {
    const valueRef = "fixture.sampletxt";
    const envKey = resolveValueRefEnvKey(valueRef);
    process.env[envKey] = "sample.txt";
    try {
      const resolved = resolveUploadFixturePath(valueRef, {}, env);
      assert.equal(resolved, join(fixtureDir, "sample.txt"));
      assert.equal(lstatSync(resolved).isFile(), true);
    } finally {
      delete process.env[envKey];
    }
  } finally {
    if (prev === undefined) delete process.env.TESTPILOT_FIXTURE_DIR;
    else process.env.TESTPILOT_FIXTURE_DIR = prev;
    await rm(parent, { recursive: true, force: true });
  }
});

test("missing valueRef fails before the fixture directory is touched", async () => {
  const parent = await mkdtemp(join(tmpdir(), "tp-upload-miss-"));
  try {
    const missingDir = join(parent, "does-not-exist");
    assert.throws(
      () =>
        resolveUploadFixturePath("fixture.missing", {}, {
          baseUrl: "http://127.0.0.1",
          fixtureDir: missingDir,
        }),
      /upload valueRef is not set: fixture.missing/,
    );
    assert.equal(lstatSync(parent).isDirectory(), true);
    assert.throws(() => lstatSync(missingDir), /ENOENT/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("directory, outside path, and symlink escape fail without reading the file", async () => {
  const { parent, fixtureDir, secret, env } = await layout();
  const fifo = join(parent, "blocked.fifo");
  const made = spawnSync("mkfifo", [fifo]);
  assert.equal(made.status, 0, made.stderr?.toString());
  await symlink(fifo, join(fixtureDir, "escape-fifo.txt"));
  await symlink(secret, join(fixtureDir, "escape.txt"));
  await symlink(join(fixtureDir, "sample.txt"), join(fixtureDir, "alias.txt"));
  try {
    assert.throws(
      () => resolveUploadFixturePath("fixture.dir", { "fixture.dir": "subdir" }, env),
      /upload path must be a file, not a directory/,
    );
    assert.throws(
      () => resolveUploadFixturePath("fixture.dot", { "fixture.dot": "." }, env),
      /upload path must be a file, not a directory/,
    );
    assert.throws(
      () => resolveUploadFixturePath("fixture.up", { "fixture.up": "../secret.txt" }, env),
      /upload path must not contain \.\./,
    );
    assert.throws(
      () => resolveUploadFixturePath("fixture.hop", { "fixture.hop": "subdir/../../secret.txt" }, env),
      /upload path must not contain \.\./,
    );
    assert.throws(
      () => resolveUploadFixturePath("fixture.abs", { "fixture.abs": secret }, env),
      /upload path escapes fixture directory/,
    );
    assert.throws(
      () => resolveUploadFixturePath("fixture.fifoabs", { "fixture.fifoabs": fifo }, env),
      /upload path escapes fixture directory/,
    );
    const started = Date.now();
    assert.throws(
      () => resolveUploadFixturePath("fixture.link", { "fixture.link": "escape.txt" }, env),
      /upload path escapes fixture directory/,
    );
    assert.throws(
      () => resolveUploadFixturePath("fixture.fifo", { "fixture.fifo": "escape-fifo.txt" }, env),
      /upload path escapes fixture directory/,
    );
    assert.ok(Date.now() - started < 1000, "symlink escape must not block on the target");

    assert.throws(
      () => resolveUploadFixturePath("fixture.gone", { "fixture.gone": "missing.txt" }, env),
      /upload fixture file is missing: fixture.gone/,
    );

    const alias = resolveUploadFixturePath("fixture.alias", { "fixture.alias": "alias.txt" }, env);
    assert.equal(alias, join(fixtureDir, "sample.txt"));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

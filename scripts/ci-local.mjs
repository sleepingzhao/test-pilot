#!/usr/bin/env node
/**
 * Optional local check before push — same steps as former GitHub workflow.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    ...opts,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function runIn(dir, cmd, args) {
  run(cmd, args, { cwd: join(root, dir) });
}

console.log("ci-local: pnpm build");
run("pnpm", ["build"]);

console.log("ci-local: validate IR files");
for (const sub of ["examples/demo-webapp/tests", "examples/pilot-admin/tests"]) {
  const dir = join(root, sub);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    run("pnpm", ["cli", "validate", join(sub, f)]);
  }
}

console.log("ci-local: unit tests");
runIn("packages/test-ir", "pnpm", ["exec", "tsx", "--test", "src/validate.test.ts"]);
runIn("packages/planner", "pnpm", ["test"]);
runIn("packages/assertions", "pnpm", ["test"]);
runIn("packages/fixtures", "pnpm", ["test"]);
runIn("packages/recorder-web", "pnpm", ["test"]);
runIn("services/test-management", "pnpm", ["test"]);

console.log("ci-local: smoke:demo");
run("pnpm", ["smoke:demo"]);

console.log("ci-local: OK");

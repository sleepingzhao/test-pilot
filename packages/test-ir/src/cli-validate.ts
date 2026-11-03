#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { validateSemantics, validateTestIR } from "./validate.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: validate <path-to-test.json>");
  process.exit(2);
}

const raw = JSON.parse(readFileSync(file, "utf8"));
const result = validateTestIR(raw);
if (!result.ok) {
  console.error(JSON.stringify({ ok: false, issues: result.issues }, null, 2));
  process.exit(1);
}

const semantic = validateSemantics(result.value);
if (semantic.length > 0) {
  console.error(JSON.stringify({ ok: false, issues: semantic }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, id: result.value.id, version: result.value.version }, null, 2));

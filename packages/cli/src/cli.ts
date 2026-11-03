#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { resolveBaseUrl } from "@testpilot/fixtures";
import { recordSession } from "@testpilot/recorder-web";
import { runTestIR } from "@testpilot/runner-web";
import { validateSemantics, validateTestIR } from "@testpilot/test-ir";

const program = new Command();

program.name("testpilot").description("TestPilot CLI — validate and run Test IR (Web)").version("0.1.0");

program
  .command("validate")
  .argument("<file>", "path to test IR JSON")
  .description("Validate Test IR against schema v1")
  .action((file: string) => {
    const doc = JSON.parse(readFileSync(resolve(file), "utf8"));
    const result = validateTestIR(doc);
    if (!result.ok) {
      console.error(JSON.stringify(result, null, 2));
      process.exit(1);
    }
    const semantic = validateSemantics(result.value);
    if (semantic.length) {
      console.error(JSON.stringify({ ok: false, issues: semantic }, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, id: result.value.id }, null, 2));
  });

program
  .command("run")
  .argument("<file>", "path to test IR JSON")
  .option("--base-url <url>", "target base URL", "http://127.0.0.1:4173")
  .option("--headed", "run browser headed")
  .option("--artifacts <dir>", "artifacts output directory", "artifacts")
  .option("-o, --output <file>", "write JSON run result to file")
  .description("Execute an approved Test IR with Playwright (no LLM)")
  .action(async (file: string, opts: { baseUrl: string; headed?: boolean; artifacts: string; output?: string }) => {
    const doc = JSON.parse(readFileSync(resolve(file), "utf8"));
    const validated = validateTestIR(doc);
    if (!validated.ok) {
      console.error(JSON.stringify(validated, null, 2));
      process.exit(1);
    }
    const ir = validated.value;
    const env = {
      baseUrl: resolveBaseUrl(ir, {
        baseUrl: opts.baseUrl,
        baseUrlRefs: { "staging-console": opts.baseUrl, "default-env": opts.baseUrl },
      }),
    };
    const result = await runTestIR(ir, {
      headless: !opts.headed,
      artifactsDir: opts.artifacts,
      env,
    });
    const json = JSON.stringify(result, null, 2);
    if (opts.output) {
      writeFileSync(opts.output, json);
    }
    console.log(json);
    process.exit(result.status === "passed" ? 0 : 1);
  });

program
  .command("record")
  .requiredOption("--url <url>", "start URL to open")
  .option("--id <testId>", "Test IR id", "recorded-test")
  .option("-o, --output <file>", "write Test IR JSON")
  .description("Open a browser; interact with the app; close the window to save steps as Test IR")
  .action(async (opts: { url: string; id: string; output?: string }) => {
    console.error("Recording… Close the browser window when finished.");
    const { ir, warnings } = await recordSession({ url: opts.url, testId: opts.id });
    const schemaResult = validateTestIR(ir);
    if (!schemaResult.ok) {
      console.error(JSON.stringify(schemaResult, null, 2));
      process.exit(1);
    }
    const json = JSON.stringify(ir, null, 2);
    if (opts.output) {
      writeFileSync(resolve(opts.output), json);
      console.error(`Wrote ${opts.output}`);
    } else {
      console.log(json);
    }
    for (const w of warnings) {
      console.error(`⚠ ${w}`);
    }
    console.error("Next: edit assertions (replace REPLACE_WITH_EXPECTED_TEXT), then: pnpm cli validate <file>");
  });

program.parse();

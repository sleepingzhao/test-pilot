import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestIR } from "@testpilot/test-ir";
import { loadAssertionAgentConfigs } from "./agent-config.js";
import { loadAssertionDbConfigs, getDbConfigBundle, resolveConfigEnvRef } from "./db-config.js";
import { createReadonlyDbClient, type ReadonlyDbClient } from "./readonly-db-client.js";
import { createTraceClient } from "./trace-client.js";

export type RunEnvironment = {
  baseUrl: string;
  /** Named env refs, e.g. staging-console → URL */
  baseUrlRefs?: Record<string, string>;
  /** Maps requestRef in IR to URL/method patterns (roadmap §8). */
  requestRefs?: Record<string, { urlIncludes: string; method?: string }>;
  /** Fixture-scoped values; secrets via env, never in IR */
  fixtureValues?: Record<string, string>;
  /**
   * Directory upload paths must stay inside. Overrides `TESTPILOT_FIXTURE_DIR`.
   * The file path itself still comes from `valueRef`, never from the IR.
   */
  fixtureDir?: string;
  commitSha?: string;
  /** Injected readonly DB client (tests) or built from assertion-db-config at run time. */
  readonlyDb?: import("./readonly-db-client.js").ReadonlyDbClient;
  /** Injected trace client (tests) or built from assertion-agent-config at run time. */
  agentTraces?: import("./trace-client.js").TraceClient;
};

export function resolveFixtureRefs(fixtureName: string | undefined, env: RunEnvironment): void {
  if (!fixtureName) return;
  // V0.1: fixture hook only; setup/teardown comes in v0.3
  void env;
}

/** Maps IR valueRef → process.env key (secrets stay out of repo IR). */
const VALUE_REF_ENV_KEYS: Record<string, string> = {
  "env.adminPhone": "TESTPILOT_ENV_ADMIN_PHONE",
  "env.adminPassword": "TESTPILOT_ENV_ADMIN_PASSWORD",
  "env.ticketPhone": "TESTPILOT_ENV_ADMIN_PHONE",
};

export function resolveValueRefEnvKey(valueRef: string): string {
  return VALUE_REF_ENV_KEYS[valueRef] ?? `TESTPILOT_${valueRef.replace(/\./g, "_").toUpperCase()}`;
}

export function resolveValueRefs(ir: TestIR, env: RunEnvironment): Record<string, string> {
  const map: Record<string, string> = { ...(env.fixtureValues ?? {}) };
  for (const step of ir.steps) {
    if (!step.valueRef) continue;
    if (map[step.valueRef] !== undefined) continue;
    const envKey = resolveValueRefEnvKey(step.valueRef);
    const fromEnv = process.env[envKey];
    if (fromEnv !== undefined && fromEnv !== "") {
      map[step.valueRef] = fromEnv;
    }
  }
  return map;
}

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../..");
}

/** `TESTPILOT_FIXTURE_DIR`, or `examples/fixtures` under the repo root. */
export function resolveUploadFixtureDir(env: RunEnvironment): string {
  const configured = env.fixtureDir?.trim() || process.env.TESTPILOT_FIXTURE_DIR?.trim();
  if (!configured) return join(repoRoot(), "examples/fixtures");
  return isAbsolute(configured) ? configured : resolve(repoRoot(), configured);
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

function isOutside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function errnoCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : undefined;
}

function isContained(rootResolved: string, rootReal: string, target: string): boolean {
  return !isOutside(rootResolved, target) || !isOutside(rootReal, target);
}

/**
 * Resolve an upload `valueRef` to a real file inside the fixture directory.
 * The IR stores only the ref. `..`, absolute paths outside the directory,
 * symlink escapes, directories, and missing files are rejected without reading bytes.
 */
export function resolveUploadFixturePath(
  valueRef: string,
  refs: Record<string, string>,
  env: RunEnvironment,
): string {
  const raw =
    nonEmpty(refs[valueRef]) ??
    nonEmpty(env.fixtureValues?.[valueRef]) ??
    nonEmpty(process.env[resolveValueRefEnvKey(valueRef)]);
  if (raw === undefined) throw new Error(`upload valueRef is not set: ${valueRef}`);
  if (raw.includes("\0")) throw new Error("upload path is invalid");
  if (/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(raw)) throw new Error("upload path must not contain ..");

  const rootResolved = resolve(resolveUploadFixtureDir(env));
  const candidate = resolve(rootResolved, raw);
  if (isOutside(rootResolved, candidate)) throw new Error("upload path escapes fixture directory");

  let rootReal: string;
  try {
    rootReal = realpathSync(rootResolved);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") throw new Error("fixture directory is missing");
    throw new Error("fixture directory is not a directory");
  }
  if (!lstatSync(rootReal).isDirectory()) throw new Error("fixture directory is not a directory");

  let current = candidate;
  const seen = new Set<string>();
  for (let hop = 0; hop < 32; hop++) {
    if (!isContained(rootResolved, rootReal, current)) {
      throw new Error("upload path escapes fixture directory");
    }
    let stat;
    try {
      stat = lstatSync(current);
    } catch (err) {
      if (errnoCode(err) === "ENOENT") throw new Error(`upload fixture file is missing: ${valueRef}`);
      throw new Error(`upload fixture path is invalid: ${valueRef}`);
    }
    if (stat.isSymbolicLink()) {
      if (seen.has(current)) throw new Error("upload path escapes fixture directory");
      seen.add(current);
      const next = resolve(dirname(current), readlinkSync(current));
      if (!isContained(rootResolved, rootReal, next)) {
        throw new Error("upload path escapes fixture directory");
      }
      current = next;
      continue;
    }
    if (stat.isDirectory()) throw new Error("upload path must be a file, not a directory");
    if (!stat.isFile()) throw new Error("upload path must be a regular file");
    return current;
  }
  throw new Error("upload path escapes fixture directory");
}

export function resolveBaseUrl(ir: TestIR, env: RunEnvironment): string {
  if (ir.baseUrl) return ir.baseUrl;
  if (ir.baseUrlRef && env.baseUrlRefs?.[ir.baseUrlRef]) {
    return env.baseUrlRefs[ir.baseUrlRef];
  }
  return env.baseUrl;
}

const DEFAULT_REQUEST_REFS: Record<string, { urlIncludes: string; method?: string }> = {
  "users-create-attempt": { urlIncludes: "/api/users", method: "POST" },
  "api-users-create": { urlIncludes: "/api/users", method: "POST" },
  "users-lookup-existing-email": { urlIncludes: "/api/users", method: "POST" },
  "tickets-create-attempt": { urlIncludes: "/api/tickets", method: "POST" },
  "pilot-ticket-submit": {
    urlIncludes: process.env.TESTPILOT_PILOT_TICKET_API_INCLUDES ?? "/api/workorder/workOrder/create",
    method: "POST",
  },
};

export function resolveRequestRef(
  ref: string,
  env: RunEnvironment,
): { urlIncludes: string; method?: string } | undefined {
  if (env.requestRefs?.[ref]) return env.requestRefs[ref];
  return DEFAULT_REQUEST_REFS[ref];
}

export type { DbConfigBundle } from "./db-config.js";
export {
  getDbConfigBundle,
  loadAssertionDbConfigs,
  resolveConfigEnvRef,
} from "./db-config.js";
export {
  assertSafeReadonlySql,
  bindNamedParams,
  createReadonlyDbClient,
  type DbClientFactoryOptions,
  type DbQueryResult,
  type ReadonlyDbClient,
} from "./readonly-db-client.js";

export function buildReadonlyDbClient(env: RunEnvironment): ReadonlyDbClient | undefined {
  if (env.readonlyDb) return env.readonlyDb;
  const configs = loadAssertionDbConfigs();
  if (Object.keys(configs).length === 0) return undefined;
  return createReadonlyDbClient({ configs });
}

export type { AgentConfigBundle } from "./agent-config.js";
export { computeAssertionConfigHash, invalidateAssertionConfigCache } from "./config-hash.js";
export { waitForHttpReady } from "./wait-ready.js";
export {
  getAgentConfigBundle,
  loadAssertionAgentConfigs,
} from "./agent-config.js";
export type {
  AgentToolCall,
  ImportedAgentTrace,
  TraceClient,
  TraceClientFactoryOptions,
} from "./trace-client.js";
export { createTraceClient, parseAgentTraceJson } from "./trace-client.js";

export function buildAgentTraceClient(
  env: RunEnvironment,
): import("./trace-client.js").TraceClient | undefined {
  if (env.agentTraces) return env.agentTraces;
  const configs = loadAssertionAgentConfigs();
  if (Object.keys(configs).length === 0) return undefined;
  return createTraceClient({ configs });
}

export async function probeDbConnection(
  configRef: string,
  repoRoot?: string,
): Promise<{ ok: boolean; message: string; configured: boolean; queryNames: string[] }> {
  const bundle = getDbConfigBundle(configRef, repoRoot);
  if (!bundle) {
    return { ok: false, message: `unknown configRef: ${configRef}`, configured: false, queryNames: [] };
  }
  const queryNames = Object.keys(bundle.queries);
  const connectionString = resolveConfigEnvRef(bundle.connectionRef);
  if (!connectionString) {
    return {
      ok: false,
      message: "connection env not configured",
      configured: false,
      queryNames,
    };
  }
  try {
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString, max: 1 });
    try {
      await pool.query("SELECT 1 AS ok");
      return { ok: true, message: "connected", configured: true, queryNames };
    } finally {
      await pool.end();
    }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      configured: true,
      queryNames,
    };
  }
}

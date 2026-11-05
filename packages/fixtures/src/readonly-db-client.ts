import { parse } from "pgsql-ast-parser";
import type { DbConfigBundle } from "./db-config.js";
import { resolveConfigEnvRef } from "./db-config.js";

export type DbQueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number;
};

export type ReadonlyDbClient = {
  runNamedQuery: (
    configRef: string,
    queryRef: string,
    params: Record<string, string | number>,
  ) => Promise<DbQueryResult>;
};

const SELECT_OR_CTE = /^\s*(select|with)\b/i;
const FORBIDDEN_FUNCS = [
  "pg_read_file",
  "pg_sleep",
  "pg_write_file",
  "lo_import",
  "lo_export",
  "dblink",
  "pg_execute",
];

function stripSqlComments(sql: string): string {
  let out = sql.replace(/\/\*[\s\S]*?\*\//g, " ");
  out = out.replace(/--[^\n\r]*/g, " ");
  return out;
}

type AstNode = Record<string, unknown>;

function collectTableRefs(
  node: unknown,
  tables: string[],
  cteNames: Set<string>,
  inFrom = false,
): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectTableRefs(item, tables, cteNames, inFrom);
    return;
  }

  const obj = node as AstNode;
  const type = typeof obj.type === "string" ? obj.type : undefined;

  if (type?.startsWith("with")) {
    const aliases = new Set(cteNames);
    const bind = obj.bind;
    if (Array.isArray(bind)) {
      for (const item of bind) {
        const alias = (item as { alias?: { name?: unknown } }).alias?.name;
        if (typeof alias === "string") aliases.add(alias);
      }
      for (const item of bind) {
        collectTableRefs((item as { statement?: unknown }).statement, tables, aliases);
      }
    }
    collectTableRefs(obj.in, tables, aliases);
    return;
  }

  if (type === "table") {
    const name = (obj.name as { name?: unknown } | undefined)?.name;
    if (typeof name === "string" && !cteNames.has(name)) tables.push(name.toLowerCase());
  }

  if (type === "call" && inFrom) {
    throw new Error("table functions in FROM are not allowed");
  }

  for (const [key, value] of Object.entries(obj)) {
    if (key === "type" || key === "name" || key === "alias") continue;
    if (key === "from" && Array.isArray(value)) {
      for (const item of value) collectTableRefs(item, tables, cteNames, true);
    } else {
      collectTableRefs(value, tables, cteNames, false);
    }
  }
}

function extractReferencedTables(sql: string): string[] {
  let statements: ReturnType<typeof parse>;
  try {
    statements = parse(sql);
  } catch (err) {
    throw new Error(`invalid SQL: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (statements.length !== 1) {
    throw new Error("multiple SQL statements are not allowed");
  }
  const tables: string[] = [];
  for (const statement of statements) collectTableRefs(statement, tables, new Set());
  return tables;
}

/** Second-line guard only — DB account must still be read-only with least privilege. */
export function assertSafeReadonlySql(sql: string, allowedTables: string[]): void {
  const normalized = stripSqlComments(sql).trim();
  if (!SELECT_OR_CTE.test(normalized)) {
    throw new Error("only SELECT queries are allowed");
  }
  if (/;\s*\S/.test(normalized)) {
    throw new Error("multiple SQL statements are not allowed");
  }
  if (/\bselect\b[\s\S]*\binto\b/i.test(normalized)) {
    throw new Error("SELECT INTO is not allowed");
  }
  const lower = normalized.toLowerCase();
  for (const forbidden of ["insert", "update", "delete", "drop", "alter", "truncate", "create", "grant", "revoke"]) {
    if (new RegExp(`\\b${forbidden}\\b`, "i").test(lower)) {
      throw new Error(`forbidden SQL keyword: ${forbidden}`);
    }
  }
  for (const fn of FORBIDDEN_FUNCS) {
    if (new RegExp(`\\b${fn}\\s*\\(`, "i").test(lower)) {
      throw new Error(`forbidden SQL function: ${fn}`);
    }
  }
  const allowed = new Set(allowedTables.map((t) => t.toLowerCase()));
  const referenced = extractReferencedTables(normalized);
  if (referenced.length === 0) {
    throw new Error(`query must reference at least one allowed table: ${allowedTables.join(", ")}`);
  }
  for (const table of referenced) {
    if (!allowed.has(table)) {
      throw new Error(`table not allowed: ${table}`);
    }
  }
}

export function bindNamedParams(
  sql: string,
  params: Record<string, string | number>,
): { text: string; values: (string | number)[] } {
  const values: (string | number)[] = [];
  const text = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name: string) => {
    if (!(name in params)) throw new Error(`missing query param :${name}`);
    values.push(params[name]!);
    return `$${values.length}`;
  });
  return { text, values };
}

function isDbEnvironmentError(message: string): boolean {
  return /connection|ECONNREFUSED|ENOTFOUND|timeout|password authentication|does not exist|not configured/i.test(
    message,
  );
}

export type DbClientFactoryOptions = {
  configs: Record<string, DbConfigBundle>;
  /** When set, used instead of PostgreSQL (unit tests). */
  mockExecute?: (
    configRef: string,
    queryRef: string,
    params: Record<string, string | number>,
  ) => Promise<DbQueryResult>;
};

export function createReadonlyDbClient(opts: DbClientFactoryOptions): ReadonlyDbClient {
  return {
    async runNamedQuery(configRef, queryRef, params) {
      if (opts.mockExecute) {
        return opts.mockExecute(configRef, queryRef, params);
      }
      const bundle = opts.configs[configRef];
      if (!bundle) throw new Error(`unknown db configRef: ${configRef}`);
      const sql = bundle.queries[queryRef];
      if (!sql) throw new Error(`unknown queryRef: ${queryRef}`);
      const { text, values } = bindNamedParams(sql, params);
      assertSafeReadonlySql(text, bundle.allowedTables);
      const connectionString = resolveConfigEnvRef(bundle.connectionRef);
      if (!connectionString) {
        throw new Error(`db connection not configured for ${configRef}`);
      }
      try {
        const pg = await import("pg");
        const pool = new pg.default.Pool({ connectionString, max: 1, ssl: undefined });
        try {
          const result = await pool.query(text, values);
          return {
            rows: result.rows as Record<string, unknown>[],
            rowCount: result.rowCount ?? result.rows.length,
          };
        } finally {
          await pool.end();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isDbEnvironmentError(message)) {
          const e = new Error(message);
          (e as Error & { errorKind?: string }).errorKind = "ENVIRONMENT";
          throw e;
        }
        throw err;
      }
    },
  };
}

export { isDbEnvironmentError };

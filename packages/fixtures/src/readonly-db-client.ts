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

const SELECT_ONLY = /^\s*select\b/i;

export function assertSafeReadonlySql(sql: string, allowedTables: string[]): void {
  const normalized = sql.replace(/\/\*[\s\S]*?\*\//g, " ").trim();
  if (!SELECT_ONLY.test(normalized)) {
    throw new Error("only SELECT queries are allowed");
  }
  const lower = normalized.toLowerCase();
  for (const forbidden of ["insert", "update", "delete", "drop", "alter", "truncate", "create"]) {
    if (new RegExp(`\\b${forbidden}\\b`, "i").test(lower)) {
      throw new Error(`forbidden SQL keyword: ${forbidden}`);
    }
  }
  for (const table of allowedTables) {
    if (new RegExp(`\\b${table}\\b`, "i").test(normalized)) {
      return;
    }
  }
  throw new Error(`query must reference at least one allowed table: ${allowedTables.join(", ")}`);
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
      assertSafeReadonlySql(sql, bundle.allowedTables);
      const connectionString = resolveConfigEnvRef(bundle.connectionRef);
      if (!connectionString) {
        throw new Error(`db connection not configured for ${configRef}`);
      }
      const { text, values } = bindNamedParams(sql, params);
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
    },
  };
}

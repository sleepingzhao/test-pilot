import type { TestAssertion, ValidationIssue } from "@testpilot/test-ir";
import type { DbConfigBundle } from "@testpilot/fixtures";
import { partialJsonMatch } from "./api-match.js";
import type { AssertionContext, AssertionOutcome } from "./types.js";

type DbExpect = {
  queryRef?: string;
  rowCount?: number;
  minRowCount?: number;
  row?: Record<string, unknown>;
  params?: Record<string, string>;
};

function resolveParamValue(raw: string, runId: string): string {
  return raw.replace(/\{\{runId\}\}/g, runId);
}

function buildQueryParams(expect: DbExpect, runId: string): Record<string, string | number> {
  const out: Record<string, string | number> = { runId };
  if (expect.params) {
    for (const [key, value] of Object.entries(expect.params)) {
      out[key] = resolveParamValue(String(value), runId);
    }
  }
  return out;
}

export function validatePostgresReadonlyAssertion(
  assertion: TestAssertion,
  resolveDbConfig?: (configRef: string) => DbConfigBundle | undefined,
): ValidationIssue[] {
  if (assertion.type !== "db") return [];
  const issues: ValidationIssue[] = [];
  if (assertion.provider && assertion.provider !== "postgres-readonly") return [];
  if (!assertion.configRef) {
    issues.push({ path: "configRef", message: "DB 断言需要 configRef" });
  }
  const expect = (assertion.expect ?? {}) as DbExpect;
  if (!expect.queryRef) {
    issues.push({ path: "expect/queryRef", message: "DB 断言需要 expect.queryRef（命名查询）" });
  }
  if ("sql" in expect || "query" in expect) {
    issues.push({ path: "expect", message: "禁止在 IR 中写 SQL；请使用 queryRef" });
  }
  if (assertion.configRef && expect.queryRef && resolveDbConfig) {
    const bundle = resolveDbConfig(assertion.configRef);
    if (!bundle) {
      issues.push({ path: "configRef", message: `未知的 DB 配置: ${assertion.configRef}` });
    } else if (!bundle.queries[expect.queryRef]) {
      issues.push({
        path: "expect/queryRef",
        message: `配置中不存在命名查询: ${expect.queryRef}`,
      });
    }
  }
  return issues;
}

export async function runPostgresReadonlyAssertion(
  assertion: TestAssertion,
  ctx: AssertionContext,
): Promise<AssertionOutcome> {
  const id = assertion.id ?? "db-assertion";
  if (assertion.type !== "db") {
    return {
      assertionId: id,
      passed: false,
      errorKind: "ASSERTION_ORACLE",
      message: `expected db assertion, got ${assertion.type}`,
    };
  }

  const configRef = assertion.configRef;
  const expect = (assertion.expect ?? {}) as DbExpect;
  const runId = ctx.runId ?? "run_unknown";

  if (!configRef) {
    return {
      assertionId: id,
      passed: false,
      errorKind: "ASSERTION_ORACLE",
      message: "db assertion requires configRef",
    };
  }
  if (!expect.queryRef) {
    return {
      assertionId: id,
      passed: false,
      errorKind: "ASSERTION_ORACLE",
      message: "db assertion requires expect.queryRef",
    };
  }
  if (!ctx.db) {
    return {
      assertionId: id,
      passed: false,
      errorKind: "ENVIRONMENT",
      message: "db client not configured (missing connection or assertion-db-config)",
    };
  }

  try {
    const params = buildQueryParams(expect, runId);
    const result = await ctx.db.runNamedQuery(configRef, expect.queryRef, params);
    const evidence = {
      queryRef: expect.queryRef,
      configRef,
      rowCount: result.rowCount,
      rows: result.rows.slice(0, 5),
    };

    if (typeof expect.rowCount === "number" && result.rowCount !== expect.rowCount) {
      return {
        assertionId: id,
        passed: false,
        expected: { ...expect, rowCount: expect.rowCount },
        actual: evidence,
        errorKind: "PRODUCT_DEFECT",
        message: `expected rowCount ${expect.rowCount}, got ${result.rowCount}`,
      };
    }

    if (typeof expect.minRowCount === "number" && result.rowCount < expect.minRowCount) {
      return {
        assertionId: id,
        passed: false,
        expected: expect,
        actual: evidence,
        errorKind: "PRODUCT_DEFECT",
        message: `expected at least ${expect.minRowCount} rows, got ${result.rowCount}`,
      };
    }

    if (expect.row && typeof expect.row === "object") {
      const primary = result.rows[0];
      const passed = partialJsonMatch(expect.row, primary);
      if (!passed) {
        return {
          assertionId: id,
          passed: false,
          expected: expect.row,
          actual: evidence,
          errorKind: "PRODUCT_DEFECT",
          message: "row fields did not match expect.row",
        };
      }
    }

    return {
      assertionId: id,
      passed: true,
      expected: expect,
      actual: evidence,
    };
  } catch (err) {
    return {
      assertionId: id,
      passed: false,
      errorKind: "ASSERTION_ORACLE",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

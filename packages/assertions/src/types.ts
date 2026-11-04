import type { Page } from "playwright";
import type { DbConfigBundle, ReadonlyDbClient } from "@testpilot/fixtures";

export type CapturedNetworkEntry = {
  url: string;
  method: string;
  status?: number;
  resourceType?: string;
  requestBody?: string;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
};

export type RequestRefSpec = {
  urlIncludes: string;
  method?: string;
};

export type FailureKind =
  | "PRODUCT_DEFECT"
  | "LOCATOR_BREAKAGE"
  | "ENVIRONMENT"
  | "TEST_DATA"
  | "ASSERTION_ORACLE"
  | "UNKNOWN";

export type AssertionOutcome = {
  assertionId: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  errorKind?: FailureKind;
  message?: string;
};

export type AssertionContext = {
  page: Page;
  runId?: string;
  network?: CapturedNetworkEntry[];
  resolveRequestRef?: (ref: string) => RequestRefSpec | undefined;
  resolveRef?: (ref: string) => unknown;
  db?: ReadonlyDbClient;
  resolveDbConfig?: (configRef: string) => DbConfigBundle | undefined;
};

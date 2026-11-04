import type { Page } from "playwright";

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
  network?: CapturedNetworkEntry[];
  resolveRequestRef?: (ref: string) => RequestRefSpec | undefined;
  resolveRef?: (ref: string) => unknown;
};

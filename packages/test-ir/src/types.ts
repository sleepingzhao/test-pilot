export type OracleSource = "human-approved" | "requirement" | "api-contract";

export type Platform = "web";

export type StepAction = "navigate" | "click" | "fill" | "press" | "wait" | "select" | "selectCascader" | "request" | "upload";

export type RequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export interface Locator {
  testId?: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  css?: string;
}

export interface TestStep {
  id: string;
  action: StepAction;
  path?: string;
  target?: Locator;
  value?: string;
  /** Env/fixture key. For `upload`, this is the only file path source; the path is not stored in the IR. */
  valueRef?: string;
  key?: string;
  /** Ordered labels for each cascader level (province → street). */
  cascaderPath?: string[];
  /** HTTP method for `action: "request"`. Same-origin with baseUrl only. */
  method?: RequestMethod;
  /** Request headers. Values may contain `{{var}}` templates (resolved at run time). */
  headers?: Record<string, string>;
  /** JSON object or raw string body. Mutually exclusive with `form`. No file upload. */
  body?: string | Record<string, unknown>;
  /** `application/x-www-form-urlencoded` fields. Mutually exclusive with `body`. */
  form?: Record<string, string>;
  /** Variable name that stores the raw response body for later steps. */
  saveAs?: string;
  /** Variable name → dot path into the JSON response body. */
  saveFields?: Record<string, string>;
}

export interface TestAssertion {
  id?: string;
  type: "ui" | "api" | "db" | "event" | "agent" | "custom";
  provider?: string;
  configRef?: string;
  target?: Locator;
  contains?: string;
  requestRef?: string;
  /** Match the response of a `request` step by its id; no requestRef map needed. */
  stepRef?: string;
  expect?: Record<string, unknown>;
  oracle: OracleSource;
}

export interface TestPolicy {
  screenshots?: "never" | "on-failure" | "always";
  retry?: { attempts?: number; on?: string[] };
  dataIsolation?: "shared" | "per-run";
}

export interface TestIR {
  id: string;
  version: number;
  platform: Platform;
  baseUrl?: string;
  baseUrlRef?: string;
  fixture?: string;
  steps: TestStep[];
  assertions: TestAssertion[];
  policy?: TestPolicy;
}

export type ValidationIssue = {
  path: string;
  message: string;
};

export type ValidationResult =
  | { ok: true; value: TestIR }
  | { ok: false; issues: ValidationIssue[] };

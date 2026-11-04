export type OracleSource = "human-approved" | "requirement" | "api-contract";

export type Platform = "web";

export type StepAction = "navigate" | "click" | "fill" | "press" | "wait";

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
  valueRef?: string;
  key?: string;
}

export interface TestAssertion {
  id?: string;
  type: "ui" | "api" | "db" | "event";
  target?: Locator;
  contains?: string;
  requestRef?: string;
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

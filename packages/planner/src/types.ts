import type { TestAssertion, TestStep } from "@testpilot/test-ir";

export type FormFieldHint = {
  label: string;
  kind: "text" | "textarea" | "combobox";
  /** Current value for text fields; empty means the field needs input. */
  value?: string;
  /** Currently shown selection for a combobox. */
  selectedText?: string;
  /** First stable option chosen while exploring the open form. */
  option?: string;
};

export type FormHint = {
  scope: "dialog" | "page";
  title?: string;
  submitLabel?: string;
  /** How the dialog was opened; replay it if the trigger is hidden while the dialog is open. */
  openTarget?: { testId?: string; role?: string; name?: string };
  fields: FormFieldHint[];
};

export type PageContext = {
  url: string;
  elements: Array<{ role?: string; name?: string; testId?: string; inputType?: string; placeholder?: string; ariaLabel?: string; inNav?: boolean }>;
  /** Repeated block texts from div/card lists without semantic roles. */
  texts: string[];
  /** Captured after opening the form; lets planning see fields that only exist in a dialog. */
  form?: FormHint;
};

export type PlannerDraft = {
  steps: TestStep[];
  assertions: TestAssertion[];
  uncertainties: string[];
  sources: string[];
};

export type PlannerInput = {
  goal: string;
  context: PageContext;
};

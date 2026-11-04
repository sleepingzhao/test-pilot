/** Injected into the page — must be self-contained (no imports). */
export const RECORDER_INIT_SCRIPT = `
(() => {
  if (window.__testpilotRecorderInstalled) return;
  window.__testpilotRecorderInstalled = true;

  function implicitRole(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && el.getAttribute("href")) return "link";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button") return "button";
      return "textbox";
    }
    if (el.getAttribute("role")) return el.getAttribute("role");
    return null;
  }

  function textSnippet(el) {
    const t = (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ");
    return t.slice(0, 80) || undefined;
  }

  function labelFor(el) {
    if (el.id) {
      const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lbl) return (lbl.textContent || "").trim() || undefined;
    }
    const parentLabel = el.closest("label");
    if (parentLabel) return (parentLabel.textContent || "").trim().slice(0, 80) || undefined;
    return undefined;
  }

  function describeTarget(el) {
    if (!(el instanceof Element)) return null;
    const testId = el.getAttribute("data-testid");
    if (testId) return { testId };

    const role = implicitRole(el);
    const name = el.getAttribute("aria-label") || textSnippet(el);
    if (role && name) return { role, name };

    const label = labelFor(el);
    if (label) return { label };

    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return { placeholder };

    if (role) return { role, name: name || "" };

    if (el.id && !/\\d{5,}/.test(el.id)) {
      return { css: "#" + CSS.escape(el.id) };
    }
    return null;
  }

  function isSensitiveInput(el) {
    if (!(el instanceof HTMLInputElement)) return false;
    if (el.type === "password" || el.type === "tel") return true;
    const hint = (el.name + " " + el.id + " " + el.autocomplete + " " + (labelFor(el) || "")).toLowerCase();
    return /password|passwd|secret|token|phone|mobile|手机|电话/.test(hint);
  }

  function emit(payload) {
    const fn = window.__testpilotRecord;
    if (typeof fn !== "function") return;
    fn(payload).catch(() => {});
  }

  document.addEventListener(
    "click",
    (ev) => {
      const el = ev.target instanceof Element ? ev.target.closest("button, a, [role=button], input[type=submit], input[type=button]") : null;
      if (!el) return;
      const target = describeTarget(el);
      if (!target) return;
      emit({ kind: "click", target });
    },
    true,
  );

  document.addEventListener(
    "change",
    (ev) => {
      const el = ev.target;
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
      const target = describeTarget(el);
      if (!target) return;
      if (isSensitiveInput(el)) {
        emit({ kind: "fill", target, sensitive: true, fieldKey: el.name || el.id || labelFor(el) || "secret" });
        return;
      }
      emit({ kind: "fill", target, value: el.value });
    },
    true,
  );
})();
`;

export type RecordedEvent =
  | { kind: "navigate"; path: string }
  | { kind: "click"; target: Record<string, string> }
  | { kind: "fill"; target: Record<string, string>; value?: string; sensitive?: boolean; fieldKey?: string };

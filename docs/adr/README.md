# ADR-001: Platform vs execution engine boundary

**Status:** Accepted (scaffold)

The Playwright runner (`packages/runner-web`) must remain runnable as a library/CLI without the management API. Platform services communicate via stable JSON (Test IR in, Run result + artifact paths out).

# ADR-002: Test IR v1 schema

**Status:** Accepted (draft)

Schema file: `packages/test-ir/schema/test-ir.v1.schema.json`. Breaking changes bump schema `$id` / major version field on cases.

# ADR-003: Context & token budget

**Status:** Proposed

Planner receives trimmed ARIA/DOM slices only; full-page screenshots are opt-in (canvas / visual regression).

# ADR-004: Assertion oracles & self-heal

**Status:** Proposed

AI may suggest locator fixes; it must not auto-approve behavior changes. `human-approved` required for high-risk UI oracles.

# ADR-005: Fixtures & evidence redaction

**Status:** Proposed

Per-run data isolation default; artifacts redacted before storage (V0.2+).

# ADR-006: Extensible assertion engine

**Status:** Accepted（2026-11-04）

Provider registry、IR `provider`/`configRef`、内置 UI/HTTP/DB/Agent Provider、配置版本与负向验证。详见 [`ADR-006-extensible-assertions.md`](ADR-006-extensible-assertions.md)。

# ADR-007～010（待补）

断言配置版本与审批审计、安全默认值、AI 边界、本地门禁与 CI 策略。执行顺序见 [`../../ROADMAP.md`](../../ROADMAP.md)。

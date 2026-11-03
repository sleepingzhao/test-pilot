# Architecture

TestPilot splits **platform services** from the **execution engine** so Playwright runs in an isolated process with a stable contract (roadmap §4, §10).

## Layers

1. **Interface** — Web console (`apps/console`, primary UX), CLI (`packages/cli`), GitLab CI (`integrations/gitlab/run-regression.sh`).
2. **Test intelligence** — `packages/planner` + `packages/context-web` (`POST /api/plan` uses trimmed snapshots; LLM provider next).
3. **Test IR + assertions** — `packages/test-ir`, `packages/assertions`.
4. **Platform driver** — `packages/runner-web` (Playwright); mobile/Harmony adapters later.
5. **Execution & observability** — `packages/evidence`, failure classification, reports.

## Test IR v1

Canonical example: `packages/test-ir/fixtures/user-create-duplicate-email.json`.

Design rules:

- Steps are **deterministic** actions; assertions record **oracle** (`human-approved`, `requirement`, `api-contract`).
- Secrets use `valueRef` / env + fixtures — never embedded in IR or LLM prompts.
- Approved versions replay with **zero LLM** calls on the happy path.

### Locator strategy (roadmap §5)

Priority when recording or resolving steps:

1. `data-testid` → `testId` in IR (recorder stops at testId; runner tries testId first).
2. `role` + accessible **exact** name (`runner-web` / `assertions` use Playwright `exact: true` to avoid「提交」matching「提交工单」).
3. `label` / `placeholder`, then limited `css`.

Self-heal: AI may propose new locators; **approved IR is not auto-rewritten** on failure.

### API assertions (roadmap §8, V0.3 scaffold)

During a run, Playwright responses are captured in `network.json`. Assertions with `type: "api"` and `requestRef` (resolved via `@testpilot/fixtures`) match entries by URL fragment and method; `expect` supports:

- `statusCode` — HTTP status of the matched call
- `jsonBody` — partial match on **request** JSON body (e.g. `{ "email": "duplicate@example.com" }`)
- `requestBodyContains` — substring in raw request body

Evaluation uses captured traffic only (no extra HTTP at assertion time). Demo: `POST /api/users` on the练习 server (`examples/demo-webapp/server.mjs`).

## Data model (logical)

Roadmap §7.1 entities (`Project`, `TestCase`, `TestVersion`, `Run`, …) will live in `services/test-management` once PostgreSQL is added in V0.2.

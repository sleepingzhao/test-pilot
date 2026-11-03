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

## Data model (logical)

Roadmap §7.1 entities (`Project`, `TestCase`, `TestVersion`, `Run`, …) will live in `services/test-management` once PostgreSQL is added in V0.2.

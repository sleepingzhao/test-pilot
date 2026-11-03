# GitLab CI integration

V0.3 entry point: run all **approved** tests through the management API (same as Web Console「运行全部」). Happy path uses **no LLM**.

## Quick use

```bash
chmod +x integrations/gitlab/run-regression.sh
./integrations/gitlab/run-regression.sh
```

Environment:

| Variable | Default | Meaning |
|----------|---------|---------|
| `TESTPILOT_BASE_URL` | `http://127.0.0.1:4173` | Staging / demo app under test |
| `TESTPILOT_API` | `http://127.0.0.1:8787` | Test management API |

When `TESTPILOT_BASE_URL` points at local demo (`127.0.0.1:4173`), the script starts demo + API automatically. For remote staging, start only what you need and ensure the API can reach the target.

Pilot secrets (`TESTPILOT_PILOT_BASE_URL`, admin phone/password) belong in CI **masked variables**, never in the repo.

## Example `.gitlab-ci.yml` job

```yaml
regression:
  image: node:20-bookworm
  before_script:
    - corepack enable && corepack prepare pnpm@9 --activate
    - cd test-pilot && pnpm exec playwright install chromium --with-deps
  script:
    - ./integrations/gitlab/run-regression.sh
```

For MR-scoped suites later, map changed paths to Test IR files and call `pnpm cli run …` (see `packages/cli`).

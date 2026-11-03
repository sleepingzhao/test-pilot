# GitLab CI integration (stub)

V0.3 will map MR labels / changed paths to suites and invoke:

```bash
testpilot run path/to/test.json --base-url "$STAGING_URL" -o run.json
```

See roadmap §8 and `packages/cli`.

# Provider 负向探针（AS-6）

每个内置 Provider 一条**预期失败**的探针 IR：跑完后整体状态应为 `failed`，且至少一条断言未通过。

- `playwright-ui` — 页面上不存在的文案
- `captured-http` — 重复邮箱场景断言错误状态码
- `postgres-readonly` — mock 返回 0 行，断言 `rowCount: 1`
- `otel-trace` — mock trace 缺少指定工具调用
- `ws` — `/chat?drop=1` 不广播，入站帧断言必须失败

```bash
pnpm negative-probes
# 报告：artifacts/negative-probes-last.json
# API：GET /api/metrics/negative-probes
```

`pnpm verify` 会在 smoke 之后自动执行负向探针。

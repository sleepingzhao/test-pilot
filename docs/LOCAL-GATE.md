# 本地门禁（无 CI）

TestPilot **不运行 GitHub Actions 或其它自动 CI**（按项目约定）。发布前与 Agent 任务完成时的硬门槛是：

```bash
pnpm verify
```

实现见 [`scripts/ci-local.mjs`](../scripts/ci-local.mjs)，顺序如下：

| 阶段 | 内容 |
|------|------|
| typecheck | 全 workspace `build` + `typecheck` |
| validate IR | `examples/demo-webapp/tests`、`examples/pilot-admin/tests`、`examples/negative-probes` 下 JSON |
| unit tests | `test-ir`、`planner`、`assertions`、`evidence`、`fixtures`、`recorder-web`、`runner-web`、`test-management` |
| smoke:demo | 4 条 demo 用例 CLI 回放（**需** demo 应用在 `http://127.0.0.1:4173`） |
| negative-probes | 4 个 Provider 负向探针 |

## 前置条件

1. `pnpm install`
2. `pnpm --filter @testpilot/runner-web exec playwright install chromium`（首次）
3. 跑 `pnpm verify` 前启动 demo，或另开终端：`pnpm --filter @testpilot/demo-webapp start`

`runner-web` 里的 `ticket-p1.test.ts` 同样依赖 `:4173`；若 demo 未起，单元测试阶段会失败。

## 证据清理（V0.4）

```bash
pnpm clean:artifacts              # 默认 dry-run
pnpm clean:artifacts --execute    # 实际删除
```

- 仅删除 `artifacts/runs/<runId>/`；**不**改动 `data/tests`、`data/runs`、`data/batches`。
- 默认保留最近 **12** 个显式批次内的 run（`--keep-batches K`），并剔除超过 **14** 天的其余证据（`--days N`）。
- 可选 `--max-mb` 限制 `artifacts/runs` 总体积。

## 并行批跑（V0.4）

批量回归并行度：`TESTPILOT_MAX_PARALLEL`（默认 2，上限 4），见 `.env.example`。
单条用例硬超时：`TESTPILOT_RUN_TIMEOUT_MS`（默认 180000，范围 30s–10min）；超时会落一条 error run，批次继续，不会卡死。

## 与 `pnpm dev` 的关系

日常开发用 `pnpm dev`（控制台 + API + demo）。**不等同于** verify；改代码后仍应单独跑 `pnpm verify` 再 push。

## 相关文档

- 执行计划与任务状态：[`ROADMAP.md`](../ROADMAP.md)
- Agent 红线：[`AGENTS.md`](../AGENTS.md)
- ADR-010（本地优先）：[`docs/adr/README.md`](adr/README.md)

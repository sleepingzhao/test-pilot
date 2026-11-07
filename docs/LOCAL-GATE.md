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

- 证据按会话归档：`data/sessions/<sessionId>/` 保存批次或单独运行的记录，`artifacts/sessions/<sessionId>/runs/<runId>/` 保存对应产物；`sessionId` 形如 `session_batch_*` 或 `session_run_*`，batch 与 run 都有同一层 session 包裹。
- 仅删除 session 目录与探针目录；**不**改动 `data/tests`。
- **会话保留**：每个批次结束与服务启动时，只保留最近 **20** 个 session（`TESTPILOT_KEEP_SESSIONS`），`data/sessions` 与 `artifacts/sessions` 同步清理；更早的会话（含其记录与证据）会整体删除。
- 目录按业务划分：`artifacts/probes/<probeId>/`（负向探针，保留最近 20 个，`TESTPILOT_ARTIFACT_KEEP_PROBES`）、`artifacts/smoke/`。手动清理默认保留最近 **10** 个批次（`--keep-batches K`），可配合 `--days N` 与 `--max-mb` 限制总量。
- 页面导航超时默认 45s（`TESTPILOT_NAV_TIMEOUT_MS`）；试点用例共享账号在批内串行执行，避免并发登录竞态。UI 断言会等待目标文案出现（默认 8s，`TESTPILOT_UI_ASSERT_TIMEOUT_MS`），并在断言前等待点击触发的 XHR/fetch 完成，避免成功提示还没渲染就判定失败。

## 需求→测试（V0.5-lite）

入口：控制台 **创建**（唯一入口，录制为次级入口）或 `POST /api/requirement-flow`（`pnpm dev` 时 demo 须可达）。

- 自动试跑记入 `trial`，**不计入**回归指标；批准加入回归仍走 `/api/tests/:id/approve` 与 hash 校验。
- LLM 不可用时降级为规则草案，界面展示原因。

## 并行批跑（V0.4）

批量回归并行度：`TESTPILOT_MAX_PARALLEL`（默认 2，上限 4），见 `.env.example`。
单条用例硬超时：`TESTPILOT_RUN_TIMEOUT_MS`（默认 180000，范围 30s–10min）；超时会落一条 error run，批次继续，不会卡死。

## 与 `pnpm dev` 的关系

日常开发用 `pnpm dev`（控制台 + API + demo）。**不等同于** verify；改代码后仍应单独跑 `pnpm verify` 再 push。

## 相关文档

- 执行计划与任务状态：[`ROADMAP.md`](../ROADMAP.md)
- Agent 红线：[`AGENTS.md`](../AGENTS.md)
- ADR-010（本地优先）：[`docs/adr/README.md`](adr/README.md)

# TestPilot

把手工回归变成**可审阅、可重复、零 LLM 执行**的自动化测试，从 Web Console 开始。

- 执行计划：[`ROADMAP.md`](ROADMAP.md)（唯一计划）
- Agent 协议：[`AGENTS.md`](AGENTS.md)
- 本地门禁：[`docs/LOCAL-GATE.md`](docs/LOCAL-GATE.md)

## 快速开始

```bash
pnpm install
pnpm --filter @testpilot/runner-web exec playwright install chromium   # 首次
pnpm dev
```

| 服务 | 地址 |
|---|---|
| 控制台 | http://127.0.0.1:5173 |
| API | http://127.0.0.1:8787 |
| Demo 被测应用 | http://127.0.0.1:4173 |

控制台主流程：**创建**（需求/录制/接口）→ 生成并试跑 → **审阅**断言 → 批准进入回归 → **用例 / 运行全部 / 运行详情**。试跑不等于批准。

```bash
pnpm verify    # 唯一硬门槛；需 demo :4173 可达
pnpm start     # 生产式单端口：http://127.0.0.1:8787（API 托管控制台）
```

## 现在能做什么

- **生成用例**：需求文本、录制、cURL / OpenAPI 导入、文件/媒体与实时消息机制草稿。
- **iframe 微前端**：步骤与 UI 断言可用 `frame` 指定 iframe，在帧内定位与断言。
- **可信回归**：Test IR 是唯一契约；批准绑定 IR hash 与断言配置 hash；已批准回归不调用模型。
- **质量门禁**：弱断言、占位断言、Provider 校验不通过不能批准；自动审批可开，但不放宽这些门禁。
- **证据**：步骤截图、network、WebSocket、SSE、Trace；运行详情可下载。
- **多账号**：IR `actors` 多上下文执行，真实环境按 `primary` / `alt` 分别登录。
- **测试数据清理**：`policy.cleanup` + `teardownSteps`，失败也按策略清理。
- **系统画像**：规则 + LLM 识别能力与未知项；真实环境只做只读画像。
- **风险与缺口**：规则报告 + 可选 LLM 增强（分层取材、严格 JSON、去重、失败回退），存 `data/risk-reports/`。

## 生产环境

已完成：真实环境自动登录、双账号（`actors[].account`）、默认只读网络门禁、真实环境证据脱敏。

- 真实环境默认**只读**：写请求、上传、WS 发送会被阻止；只有 IR `policy.allowMutation: true` 才放行（高风险）。
- 真实运行不落截图 / Trace，network / WS / SSE 不落正文与 query，断言仍使用内存中的实时数据。
- 只读回归模板已跑通：8 条真实用例（通讯录列表/部门筛选/详情、任务、文档、提醒事项、会议），两轮批次 8/8 通过，运行均为只读且证据脱敏。

## 配置与安全

敏感配置只放仓库根目录 `.env`（已 gitignore），模板见 `.env.example`。

- 真实环境：`TESTPILOT_REAL_BASE_URL`、`TESTPILOT_ENV_REAL_*`、第二账号 `TESTPILOT_ENV_REAL_ALT_*`。
- 自动审批：`TESTPILOT_AUTO_APPROVE=1`；草稿试跑通过且强断言门禁通过后自动批准（审计 `auto:testpilot`）。
- 目标白名单：`TESTPILOT_ALLOWED_TARGETS`；控制台域名白名单：`TESTPILOT_ALLOWED_ORIGINS`。
- API 只监听 `127.0.0.1`，写请求校验 Origin；设非回环 `HOST` 时必须配 `TESTPILOT_API_TOKEN`。
- 批量并行 `TESTPILOT_MAX_PARALLEL`（默认 2）；试点共享账号自动串行。
- LLM 可选（`TESTPILOT_LLM_*`），只用于生成、诊断与画像；已批准回归零 LLM。

## 常用命令

```bash
pnpm dev
pnpm verify
pnpm smoke:demo
pnpm negative-probes
pnpm detect:validate -- --target demo    # 或 pilot / real / all
pnpm clean:artifacts                     # 默认 dry-run
pnpm clean:junk
```

## 模块

| Layer | Package |
|---|---|
| 控制台 | `apps/console` |
| Test IR / 断言 | `packages/test-ir` · `packages/assertions` |
| 生成与画像 | `packages/planner` · `packages/context-web` · `packages/detect` · `packages/mechanisms` |
| 录制与执行 | `packages/recorder-web` · `packages/runner-web` |
| 证据 / 夹具 / 平台 | `packages/evidence` · `packages/fixtures` · `packages/platform` |
| 管理与演示 | `services/test-management` · `examples/demo-webapp` |

## 数据与清理

`data/` 存用例、会话、运行与审计，`artifacts/` 存证据，均已 gitignore。默认保留最近 20 个 session（`TESTPILOT_KEEP_SESSIONS`），`pnpm clean:artifacts` 支持预览、按批次/天数/容量清理。

## 参考

- 视觉边界：[ADR-011](docs/adr/ADR-011-midscene-visual-assist.md)
- 风险分析：[ADR-012](docs/adr/ADR-012-risk-analysis.md)
- 断言扩展：[ADR-006](docs/adr/ADR-006-extensible-assertions.md)

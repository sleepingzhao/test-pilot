# TestPilot

Turn manual QA workflows into **reliable, maintainable** automated tests — **从 Web Console 开始**，无需记终端命令。

执行计划：`ROADMAP.md` · Agent 工作协议：`AGENTS.md` · 设计材料：`design/`

## 一键启动（推荐）

```bash
cd test-pilot
pnpm install          # 首次
pnpm --filter @testpilot/runner-web exec playwright install chromium   # 首次

pnpm dev              # 会先全量 build，避免 workspace 包引用旧 dist
```

会自动启动：

| 服务 | 地址 |
|------|------|
| **TestPilot 控制台** | http://127.0.0.1:5173（浏览器会自动打开） |
| API | http://127.0.0.1:8787 |
| Demo 被测应用 | http://127.0.0.1:4173 |

> 安全默认值：API 只监听 `127.0.0.1`，CORS 只放行本机控制台，写请求校验 `Origin`。若必须设 `HOST` 为非回环地址，同时设置 `TESTPILOT_API_TOKEN`，否则 API 会拒绝启动；自定义控制台域名需加入 `TESTPILOT_ALLOWED_ORIGINS`，额外测试环境需加入 `TESTPILOT_ALLOWED_TARGETS`。

在控制台里：**创建**（粘贴 PRD/需求 → 选环境 → 自动试跑报告 → 通过后一键入回归，**试跑不等于批准**；录制作为次级入口）、**运行全部用例**、**Flake 检查 ×3**、**运行详情**、**三批基线**、**审阅**、**审批审计**、下载 Trace。

**V0.5-lite 路径：** 侧栏「创建」→ 贴需求并选练习/试点/白名单环境 → 生成并试跑 → 审阅不确定项与断言 → 试跑通过时点「一键加入回归」（会二次确认 + `irHash` 审批，不会自动批准）。

证据目录可用 `pnpm clean:artifacts`（默认 dry-run，见 [`docs/LOCAL-GATE.md`](docs/LOCAL-GATE.md)）。批量并行度由 `TESTPILOT_MAX_PARALLEL` 控制（默认 2）。

本地发布前门禁（无 GitHub CI）：[`docs/LOCAL-GATE.md`](docs/LOCAL-GATE.md) · 命令 `pnpm verify`（需 demo `:4173` 可达，见文档）。

### 业务试点（P0-1）

1. 复制凭据：`cp .env.example .env` 并填写 `TESTPILOT_ENV_ADMIN_*`（勿提交 Git）
2. 重启 `pnpm dev`，用例列表会出现 **【试点】** 用例
3. 配置 `.env` 后批准「密码登录」用例，可与 Demo 用例一起回归

试点地址与凭据只放在本地 **`.env`** 和 **`docs/pilot-*.json`**（已 gitignore，见 `*.example.json` 模板）。配置完成后重启 API，会按 `pilot-intake-presets.json` **自动生成试点草稿**（无需在控制台手动创建）。

生产式单端口（构建后 API 托管静态 Console）：

```bash
pnpm start
# 打开 http://127.0.0.1:8787
```

LLM（DeepSeek 等）是可选能力，只用于草稿与诊断；密钥只写在 **`.env`** 的 `TESTPILOT_LLM_API_KEY`。默认 `deepseek` / `deepseek-chat` / 2048 tokens；provider 的 token 上限由服务端决定，错误会显示在控制台。完整变量见 `.env.example`。

Agent 工作边界见 [`AGENTS.md`](AGENTS.md)，执行计划见 [`ROADMAP.md`](ROADMAP.md)，本地门禁见 [`docs/LOCAL-GATE.md`](docs/LOCAL-GATE.md)。

## 架构（与 design 图对齐）

- **Interface**：Web Console（`apps/console`）· CLI 供脚本与高级用法
- **Intelligence**：Planner / Context（迭代中）· 回归执行 **零 LLM**
- **Test IR + Assertions**：`packages/test-ir` · `packages/assertions`
- **Platform**：Web 已可用 · Phone / Glass 见 `packages/platform` 路线图
- **Execution + Evidence**：`packages/runner-web` · `packages/evidence`
- **管理**：`services/test-management`（文件存储，后续 PostgreSQL）

## 模块

| Layer | Package / app |
| --- | --- |
| **Web Console** | `apps/console` |
| Test IR | `packages/test-ir` |
| Recorder | `packages/recorder-web` |
| Web runner | `packages/runner-web` |
| Platform roadmap | `packages/platform` |
| Management API | `services/test-management` |
| Demo + 种子用例 | `examples/demo-webapp` |

高级用户仍可用 `pnpm cli run …`（见 `ROADMAP.md` 附录）。

提交前自检（唯一硬门槛，无自动 CI）：

```bash
# 另开终端或先启动 demo：pnpm --filter @testpilot/demo-webapp start
pnpm verify
```

步骤说明见 [`docs/LOCAL-GATE.md`](docs/LOCAL-GATE.md)。

## 清理生成物

`artifacts/`、`data/`、Playwright 报告等已被 Git 忽略，不会进入提交；需要限制磁盘增长时：

```bash
pnpm clean:junk                         # 删除 .DS_Store、*.log、*.tsbuildinfo 等
pnpm clean:artifacts                    # 默认 dry-run，只预览
pnpm clean:artifacts -- --execute       # 实际删除
pnpm clean:artifacts -- --keep-batches 20 --days 30 --max-mb 512
```

默认保留最近 12 个显式批次内的 run，并删除 14 天前的其余证据；只动 `artifacts/runs`。

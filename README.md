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

在控制台里：**创建**（粘贴 PRD/需求 → 选环境 → 自动试跑报告 → 通过后一键入回归，**试跑不等于批准**；录制作为次级入口）、**系统画像**（探测环境能力与前置条件）、**用例**（按草稿与目标环境筛选，试点/练习/自定义只在实际存在对应用例时出现）、**运行全部用例**、**Flake 统计**（从最近回归批次自动计算）、**运行详情**、**三批基线**、**审阅（含审批身份）**、下载 Trace。

**V0.5-lite 路径：** 侧栏「创建」→ 贴需求并选练习/试点/白名单环境 → 生成并试跑 → 审阅不确定项与断言 → 试跑通过时点「一键加入回归」（会二次确认 + `irHash` 审批，不会自动批准）。试点工单会先打开表单、采集可见字段与下拉选项再生成步骤；成功断言优先用创建接口（HTTP 200 + 请求体里的本次运行标记），不依赖会消失的 Toast。

**审批以 IR 内容为准：** 批准时保存当时的 IR 快照；构建产物升级导致哈希算法变化时，只要 IR 内容没变，不会要求重新审阅；IR 真正变更才会退回草稿。

默认只保留最近 **20 个 session**（一次批次或一次单独试跑都算一个 session，`TESTPILOT_KEEP_SESSIONS`）：`data/sessions` 与 `artifacts/sessions` 一起清理，更早的记录和证据都会删除；也可用 `pnpm clean:artifacts` 手动预览/清理（默认 dry-run，见 [`docs/LOCAL-GATE.md`](docs/LOCAL-GATE.md)）。批量并行度由 `TESTPILOT_MAX_PARALLEL` 控制（默认 2），试点用例共享账号会串行执行以避免登录竞态。

本地发布前门禁（无 GitHub CI）：[`docs/LOCAL-GATE.md`](docs/LOCAL-GATE.md) · 命令 `pnpm verify`（需 demo `:4173` 可达，见文档）。

### 业务试点（P0-1）

1. 复制凭据：`cp .env.example .env` 并填写 `TESTPILOT_ENV_ADMIN_*`（勿提交 Git）
2. 重启 `pnpm dev`，在「创建」里选「业务试点」，贴一句需求 → 自动生成并试跑
3. 试跑通过后人工审阅步骤/断言，再点「一键加入回归」

试点地址与凭据只放在本地 **`.env`** 和 **`docs/pilot-*.json`**（已 gitignore，见 `*.example.json` 模板）。`pilot-intake-presets.json` 为空时不会自动生成试点草稿；需要预置草稿时再往该文件里加条目。

生产式单端口（构建后 API 托管静态 Console）：

```bash
pnpm start
# 打开 http://127.0.0.1:8787
```

LLM（DeepSeek 等）是可选能力：目前只用于草稿与诊断，确定性回归 **零 LLM**。按 V0.6 路线，后续只增加低置信度能力归类和独立的 Agent 语义评测（见 [`ROADMAP.md`](ROADMAP.md) §6.3），不会让 LLM 直接写回归用例。密钥只写在 **`.env`** 的 `TESTPILOT_LLM_API_KEY`。默认 `deepseek` / `deepseek-chat` / 2048 tokens；provider 的 token 上限由服务端决定，错误会显示在控制台。完整变量见 `.env.example`。

Agent 工作边界见 [`AGENTS.md`](AGENTS.md)，执行计划见 [`ROADMAP.md`](ROADMAP.md)，本地门禁见 [`docs/LOCAL-GATE.md`](docs/LOCAL-GATE.md)。

## 架构（与 design 图对齐）

- **Interface**：Web Console（`apps/console`）· CLI 供脚本与高级用法
- **Intelligence**：Planner / Context（迭代中）· Detect 能力探测（V0.6 骨架）· 确定性回归 **零 LLM**
- **Test IR + Assertions**：`packages/test-ir` · `packages/assertions`
- **Platform**：Web 已可用 · Phone / Glass 见 `packages/platform` 路线图
- **Execution + Evidence**：`packages/runner-web` · `packages/evidence`
- **管理**：`services/test-management`（文件存储，后续 PostgreSQL）

## 模块

| Layer | Package / app |
| --- | --- |
| **Web Console** | `apps/console` |
| Test IR | `packages/test-ir` |
| Planner / 页面快照 | `packages/planner` · `packages/context-web` |
| Capability detection (V0.6) | `packages/detect` |
| Recorder | `packages/recorder-web` |
| Web runner | `packages/runner-web` |
| Assertions | `packages/assertions` |
| Evidence | `packages/evidence` |
| Fixtures / 环境引用 | `packages/fixtures` |
| Platform roadmap | `packages/platform` |
| Management API | `services/test-management` |
| Demo + 种子用例 | `examples/demo-webapp` |

下一阶段（V0.6）是[能力探测与机制包](ROADMAP.md)：先发现系统是什么能力（CRUD / 实时消息 / 富媒体 / Agent 等），再用对应机制包和真实证据断言测试；实现细节见 `ROADMAP.md` §6.3。

高级用户仍可用 `pnpm cli run …`（见 `ROADMAP.md` 附录）。

提交前自检（唯一硬门槛，无自动 CI）：

```bash
# 另开终端或先启动 demo：pnpm --filter @testpilot/demo-webapp start
pnpm verify
```

步骤说明见 [`docs/LOCAL-GATE.md`](docs/LOCAL-GATE.md)。

## 清理生成物

`artifacts/`、`data/`、Playwright 报告等已被 Git 忽略，不会进入提交；需要限制磁盘增长时：

```
data/
  tests/<testId>.json              # 用例定义
  sessions/<sessionId>/            # batch 和 trial 都包在 session_* 目录下
    session.json                   # 本次会话汇总（kind: batch | trial）
    runs/<runId>.json              # 该会话内的运行记录
  reports/ · audit.jsonl · metrics.jsonl · llm-usage.json

artifacts/
  sessions/<sessionId>/runs/<runId>/   # 每次运行的 trace、network、截图、manifest
  probes/<probeId>/                    # 负向探针证据，只保留最近 20 个
  smoke/smoke-last.json · smoke/runs/  # demo smoke
  negative-probes-last.json
```

同一个 `<sessionId>` 同时出现在 `data/sessions/` 和 `artifacts/sessions/` 下：页面里的「详情与证据」只会读取该会话内对应 `<runId>` 的产物。

```bash
pnpm clean:junk                         # 删除 .DS_Store、*.log、*.tsbuildinfo 等
pnpm clean:artifacts                    # 默认 dry-run，只预览
pnpm clean:artifacts -- --execute       # 实际删除
pnpm clean:artifacts -- --keep-batches 20 --days 30 --max-mb 512
```

默认保留最近 **20 个 session**（`TESTPILOT_KEEP_SESSIONS`，data 与 artifacts 同步清理）；手动清理默认只保留最近 10 个显式批次，并删除 14 天前的其余证据；只动 `artifacts/sessions` 下的 run 目录。

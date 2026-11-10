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

能力探测校验（需 API 与目标环境已启动）：`pnpm detect:validate -- --target demo`，真实试点用 `--target pilot`，两者一起用 `--target all`；真实环境用 `--target real`（只做画像，不自动生成/试跑；稳定检查实时消息，文件/媒体随加载视图出现）。报告写入 `artifacts/detect/validate-last.json`。

### 接口直连测试（V7-0）

已批准的 IR 可以直接调用与 `baseUrl` **同源**的业务接口，并自动复用浏览器登录后的 Cookie：

```json
{
  "id": "api-user-create",
  "steps": [
    { "id": "open", "action": "navigate", "path": "/practice-login.html" },
    {
      "id": "create",
      "action": "request",
      "method": "POST",
      "path": "/api/users",
      "body": { "email": "api-{{runId}}@example.com" },
      "saveFields": { "userId": "id" }
    },
    { "id": "load", "action": "request", "method": "GET", "path": "/api/users/{{userId}}" }
  ],
  "assertions": [
    {
      "id": "created",
      "type": "api",
      "stepRef": "create",
      "expect": { "statusCode": 201, "responseJsonBody": { "ok": true } },
      "oracle": "api-contract"
    }
  ]
}
```

- 模板：`{{runId}}`、`{{变量}}`、`{{env.apiToken}}`（解析到进程变量 `TESTPILOT_ENV_API_TOKEN`）；IR 只存 env key 名。
- 响应：`saveAs` 保存原文，`saveFields` 按点路径提取字段供后续步骤使用。
- 断言：沿用 `api` / `captured-http`；`stepRef` 直接绑定 `request` 步骤 id，无需额外映射；页面操作触发的请求继续用 `requestRef`（默认映射或运行环境 `requestRefs`）。
- 证据：请求/响应写入 `network.json`，Authorization/Cookie 脱敏；请求体/响应体沿用 8 KB / 4 KB 截断。
- 限制：仅同源（跨域接口需后续白名单）；暂不支持文件上传；试点/真实接口在控制台需后续明确授权。
- 控制台：**创建 → 接口测试**，填写方法/路径/请求头/请求体与断言后「生成草稿并试跑」；草稿需人工审阅批准，批准后才进入回归。
- 示例：`examples/demo-webapp/tests/api-*.json`，已加入 `pnpm smoke:demo`。

### 文件/媒体机制（V7-5）

- `upload` 步骤用 Playwright `setInputFiles` 选择文件；IR 里只写 `valueRef`，文件路径运行时从 env 解析：
  `fixture.samplePng` → `TESTPILOT_FIXTURE_SAMPLEPNG=sample.png`。
- 路径必须位于 `TESTPILOT_FIXTURE_DIR`（默认 `examples/fixtures`）内；`..`、目录、缺失文件和符号链接逃逸（包括中间目录）都会被拒绝。
- demo 练习环境新增 `/files`：支持 PNG / JPEG / PDF、单文件 1 MB；内存存储，不落盘；`DEMO_FILES_REJECT_VALID=1` / `DEMO_FILES_ACCEPT_INVALID=1` 仅用于负向验证。
- `packages/mechanisms` 的 `planFileMedia(profile, ctx)` 只在画像识别到 `file-media`（置信度 ≥ 0.6）时生成可评审 IR：正常上传 + 可选类型/大小负例；不调用 LLM。

### 实时消息（V7-1a / V7-3a）

- 运行时采集 WebSocket 收发帧，写入 `ws.json`：方向、URL、大小、payload；单条截断 4000 字符、最多 200 帧，写入前按现有规则脱敏。
- 断言使用 `type: "event"` + `provider: "ws"`，`expect` 支持 `urlIncludes`、`direction`、`contains`、`regex`、`jsonPath` + `equals`、`minCount`、`absent`、`timeoutMs`。匹配不到或超时按 `PRODUCT_DEFECT` 失败，不会弱通过。
- demo 练习环境新增 `/chat` 与 `/ws/chat`；`/chat?drop=1` 或 `DEMO_CHAT_DROP=1` 只接收不广播，用于负向验证。`pnpm negative-probes` 现在覆盖 5 个 Provider。
- 限制：当前是单页面链路；多账号 A→B、重连、顺序、去重和 realtime 机制包在第二波。

### 业务试点（P0-1）

1. 复制凭据：`cp .env.example .env` 并填写 `TESTPILOT_ENV_ADMIN_*`（勿提交 Git）
2. 重启 `pnpm dev`，在「创建」里选「业务试点」，贴一句需求 → 自动生成并试跑
3. 试跑通过后人工审阅步骤/断言，再点「一键加入回归」

试点地址与凭据只放在本地 **`.env`** 和 **`docs/pilot-*.json`**（已 gitignore，见 `*.example.json` 模板）。`pilot-intake-presets.json` 为空时不会自动生成试点草稿；需要预置草稿时再往该文件里加条目。

### 真实环境（仅系统画像）

1. 在本地 `.env` 配置 `TESTPILOT_REAL_BASE_URL`、`TESTPILOT_ENV_REAL_ENTERPRISE_ID`、`TESTPILOT_ENV_REAL_USER_ID`、`TESTPILOT_ENV_REAL_PASSWORD`，并把 origin 加入 `TESTPILOT_ALLOWED_TARGETS`
2. 重启 `pnpm dev`，在「系统画像」选择「真实环境」
3. 只读探测；LLM 会读取有界的页面/iframe 文本、控件与接口路径证据，识别规则库未覆盖的能力（如 Agent 工具市场、MCP、技能、记忆、设备控制）并给出测试建议；`profile.json` 只保留脱敏后的能力与证据编号，页面文本、标题、人名/项目名都不会落盘。真实环境暂不开放自动生成和试跑，避免自动写入业务数据

生产式单端口（构建后 API 托管静态 Console）：

```bash
pnpm start
# 打开 http://127.0.0.1:8787
```

LLM（DeepSeek 等）是可选能力：**能力探测里 LLM 是一等分析器**，规则引擎负责采集、取证、校验和持久化，LLM 读取有界证据后给出能力、子能力、测试建议与待确认问题（真实环境只喂脱敏后的 digest，页面文本不落盘）。回归执行仍然 **零 LLM**，确定性断言不依赖模型。密钥只写在 **`.env`** 的 `TESTPILOT_LLM_API_KEY`。默认 `deepseek` / `deepseek-chat` / 2048 tokens；探测单次输出上限 8000 tokens、超时 180s，provider 的 token 上限由服务端决定，错误会显示在控制台。完整变量见 `.env.example`。

Agent 工作边界见 [`AGENTS.md`](AGENTS.md)，执行计划见 [`ROADMAP.md`](ROADMAP.md)，本地门禁见 [`docs/LOCAL-GATE.md`](docs/LOCAL-GATE.md)。

## 架构（与 design 图对齐）

- **Interface**：Web Console（`apps/console`）· CLI 供脚本与高级用法
- **Intelligence**：Planner / Context（迭代中）· Detect 能力探测（规则 + LLM 分析，V0.6）· 回归执行 **零 LLM**
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

V0.6 已完成[能力探测与系统画像](ROADMAP.md)：先发现系统是什么能力（CRUD / 实时消息 / 富媒体 / Agent 等），再按能力选择测试机制；下一阶段是 V0.7 实时消息与富媒体机制。

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

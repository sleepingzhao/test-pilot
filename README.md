# TestPilot

Turn manual QA workflows into **reliable, maintainable** automated tests — **从 Web Console 开始**，无需记终端命令。

设计材料：`design/` · 全量待办：`docs/BACKLOG.md`

## 一键启动（推荐）

```bash
cd test-pilot
pnpm install          # 首次
pnpm build            # 首次或改代码后
pnpm --filter @testpilot/runner-web exec playwright install chromium   # 首次

pnpm dev
```

会自动启动：

| 服务 | 地址 |
|------|------|
| **TestPilot 控制台** | http://127.0.0.1:5173（浏览器会自动打开） |
| API | http://127.0.0.1:8787 |
| Demo 被测应用 | http://127.0.0.1:4173 |

在控制台里：**运行全部用例**、**录制新用例**、**编辑断言**、下载 Trace。

### 业务试点 试点（P0-1）

1. 复制凭据：`cp .env.example .env` 并填写 `TESTPILOT_ENV_ADMIN_*`（勿提交 Git）
2. 重启 `pnpm dev`，用例列表会出现 **【试点】** 用例
3. 配置 `.env` 后批准「密码登录」用例，可与 Demo 用例一起回归

试点地址与凭据只放在本地 **`.env`** 和 **`docs/pilot-*.json`**（已 gitignore，见 `*.example.json` 模板）。

生产式单端口（构建后 API 托管静态 Console）：

```bash
pnpm start
# 打开 http://127.0.0.1:8787
```

## 架构（与 design 图对齐）

- **Interface**：Web Console（`apps/console`）· CLI 仍保留给 CI
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

高级用户仍可用 `pnpm cli run …`（见 `docs/BACKLOG.md`）。

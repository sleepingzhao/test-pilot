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

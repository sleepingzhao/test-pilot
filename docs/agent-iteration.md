# Agent / 自动化迭代说明

本仓库设计为 **Cursor Agent 可长期自主改代码**，人类只需维护本地 secrets 与 occasional 批准用例。

## 人类一次性 / 偶尔

| 项 | 位置 |
|----|------|
| 试点 URL | `.env` → `TESTPILOT_PILOT_BASE_URL` |
| 试点账号 | `.env` → `TESTPILOT_ENV_ADMIN_*` |
| LLM Key | `.env` → `TESTPILOT_LLM_API_KEY`（见 `.env.example`） |
| 人工基线 / 约束 | `docs/pilot-baseline.json`、`docs/pilot-constraints.json`（gitignore） |
| **批准**自动生成的试点草稿 | Web 控制台 → 审阅断言 → 保存并批准 |

改 `.env` 或拉取含 API 变更的代码后：**重启 `pnpm dev`**（或 API 进程）。

## Agent 默认会做

- 改 planner / runner / console / CI，push 到 `main`
- 练习环境 demo 用例与 `pnpm build`、单测
- 试点 **auto-intake**（`pilot-intake-presets.json`）在 API 启动时生成草稿（需 `.env` + 可达试点）
- LLM 仅用于 **草稿 / 诊断**；回归执行保持 **0 LLM**

## Agent 不会代替人类

- 在真实试点 UI 上点「最终批准」语义（避免错误断言上线）
- 访问未写入本机 `.env` 的 secret（不会读 `.env` 内容进 Git）

## 验证 LLM 已加载

`GET /api/environment` → `llm.enabled: true`，`llm.model` 为所配模型；`llmUsage` 为当前 API 进程累计 token。

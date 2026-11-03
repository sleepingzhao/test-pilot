# Agent / 自动化迭代说明

本仓库设计为 **Cursor Agent 可长期自主改代码**，人类只需维护本地 secrets 与 occasional 批准用例。

## 人类一次性 / 偶尔

| 项 | 位置 |
|----|------|
| 试点 URL / 账号 / LLM Key | 仓库根 **`.env`**（复制自 `.env.example`，**配好后一般不用改**） |
| 人工基线 / 约束 | `docs/pilot-baseline.json`、`docs/pilot-constraints.json`（gitignore） |
| **批准**新的 auto-intake 草稿 | 控制台 → 审阅 → 保存并批准（每条用例一次） |

拉取**含 API 服务代码变更**的 Git 更新后：重启 `pnpm dev` 即可；**不必**反复改 `.env`。

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

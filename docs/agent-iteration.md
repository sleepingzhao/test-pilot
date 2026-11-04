# Agent / 自动化迭代说明

**执行计划以 [`ROADMAP.md`](../ROADMAP.md) 为准；工作红线与节奏见 [`AGENTS.md`](../AGENTS.md)。**

本仓库允许 Agent 承担日常实现，但必须按路线图单任务推进，并由人类把关方向与审批。

## 人类一次性 / 偶尔

| 项 | 位置 |
|----|------|
| 试点 URL / 账号 / LLM Key | 仓库根 **`.env`**（复制自 `.env.example`，**配好后一般不用改**） |
| 人工基线 / 约束 | `docs/pilot-baseline.json`、`docs/pilot-constraints.json`（gitignore） |
| **批准**新的 auto-intake 草稿 | 控制台 → 审阅 → 保存并批准（每条用例一次） |

拉取**含 API 服务代码变更**的 Git 更新后：重启 `pnpm dev` 即可；**不必**反复改 `.env`。

## Agent 默认会做

- 从 `ROADMAP.md` 选一个任务，按 DoD 完成；不顺手扩大范围。
- 提交前**必须**运行 `pnpm verify`（typecheck、build、测试、smoke）。
- 练习环境 demo 用例与试点 auto-intake 草稿（需 `.env` + 可达试点）。
- LLM 仅用于 **草稿 / 诊断**；回归执行保持 **0 LLM**。
- 更新 `ROADMAP.md` 勾选状态并附证据。

## Agent 不会代替人类

- 在真实试点 UI 上点「最终批准」语义（避免错误断言上线）。
- 访问未写入本机 `.env` 的 secret（不会读 `.env` 内容进 Git）。
- 自行添加 CI、数据库、队列等基础设施，或修改安全默认值。

## 验证 LLM 已加载

`GET /api/environment` → `llm.enabled: true`，`llm.model` 为所配模型；`llmUsage` 为当前 API 进程累计 token 与最近一次调用错误。

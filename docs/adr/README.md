# ADR 索引

**唯一执行计划：[`../../ROADMAP.md`](../../ROADMAP.md)**

## 当前

- [ADR-006：可扩展断言引擎](ADR-006-extensible-assertions.md) — Provider 注册表、UI/HTTP/DB/Agent 断言、配置版本、负向验证。

## 基础约束（历史决策，仍然有效）

- **ADR-001**：Playwright runner 必须可作为库/CLI 独立运行；平台与执行器通过 JSON 交互。
- **ADR-002**：Test IR v1 schema 是唯一用例契约；破坏性变更升级版本。
- **ADR-003**：Planner 只接收裁剪后的 ARIA/DOM 片段；全页截图按需。
- **ADR-004**：AI 可建议 locator 修复，不得自动批准行为变更；高风险断言必须人工确认。
- **ADR-005**：每次运行隔离测试数据；证据落盘前脱敏。

## 待补

- ADR-007：断言配置版本、审批 hash 与审计。
- ADR-008：安全默认值（本机绑定、CORS 白名单、目标白名单、令牌）。
- ADR-009：AI 只建议不自动改；回归零 LLM。
- ADR-010：本地门禁优先，CI 按需。

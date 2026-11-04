# Agent 工作协议（Cursor / 自动化 Agent）

**唯一执行计划：[`ROADMAP.md`](ROADMAP.md)。先读它，再动代码。**

## 每次只做一个任务

- 从 `ROADMAP.md` 的 P0 表选一个 ID；不要顺手做别的。
- 开工前写清楚：任务 ID、改哪些文件、怎么验证、对应哪条 DoD。
- 完成后勾选 `ROADMAP.md` 的执行看板，并附证据：命令输出、测试结果、截图、artifact 路径。
- 状态只维护在 `ROADMAP.md`；不要另建待办文件。

## 红线

- 不自动批准用例；不删除或放宽弱断言门禁；不为了让测试通过而改断言。
- 不把密钥、`.env`、真实凭据写入代码、日志、IR 或 LLM prompt。
- 不改安全默认值：只绑 `127.0.0.1`、CORS 白名单、目标白名单、远程 token。
- 不添加 CI、数据库、队列、Docker 等基础设施，除非 ROADMAP 任务明确要求且用户同意。
- 不把未验证的东西写成完成；不确定就停下来问。

## 必做验证

- `pnpm verify` 必须通过；失败就修，不允许跳过。
- 新增/修改断言必须有正向 + 负向测试，证明它能在条件不满足时失败。
- UI 改动必须在浏览器实际看过。
- 安全相关改动必须有回归测试。

## 断言扩展

- 先读 [`docs/adr/ADR-006-extensible-assertions.md`](docs/adr/ADR-006-extensible-assertions.md)。
- 新断言类型走 Provider 注册表，不在 runner 里加 switch。
- DB 只读、命名参数化查询；Agent trace 只读；禁止任意 SQL/任意查询。
- 连接串、trace 源通过 `configRef` / env ref 解析，不写进 IR。

## 交接

- 报告：改了什么、证据、未验证项、下一步。
- 发现路线图与现实冲突时，先停下并记录，不要自行改方向。

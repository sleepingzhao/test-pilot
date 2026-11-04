# TestPilot 执行路线图 v0.3

## 从「能演示」到「能信任、能证明业务结果」

**2026-11-04 · 评审重规划 · Cursor 执行，Claude 定期把关**

> **唯一执行计划。** 原 `docs/BACKLOG.md` 已合并到本文件；`design/` 下的 v0.2 路线 docx 已删除，仅保留架构/概念图。状态只在本文件维护，不要另建待办文件。

## 0. 为什么重规划

v0.2 是架构草案，功能面铺得宽，但没有回答三个问题：什么算真正完成、什么不能上线、如何证明测试不是假绿。

2026-11-04 的代码评审确认了三个短板：

- **安全边界**：artifacts 路径穿越、CORS 任意源、无鉴权、SSRF 目标。已修复并有回归测试。
- **信任机制**：IR hash 对嵌套内容不敏感、审批不绑定版本、弱断言可被批准、catalog 变更可绕过复审。已修复。
- **断言质量**：旧的工单测试只断言页面出现「工单」，实际点击后只出现了「请选择省、市、区县和街道」提示，网络里没有提交请求，属于假阳性。

因此 v0.3 的第一目标不是加功能，而是：**让每条已批准的测试都能失败、都能证明业务结果，并且让扩展新断言类型成为配置工作，而不是改 runner 代码。**

## 1. 当前基线

| 能力 | 状态 | 证据 / 缺口 |
|---|---|---|
| Test IR v1 | 可用 | schema、validator、per-test baseUrl、IR hash v2 |
| Web runner | 可用 | 步骤机、重试、定位回退、trace/network/截图 |
| Web recorder | 基本可用 | 密码/手机号映射 env ref；select/cascader 尚未验证 |
| Console | 可用 | 弱断言 badge/筛选、审批 hash、首页告警；无步骤编辑器 |
| Planner | 规则式 + 可选 LLM | 否定词已修；LLM 只建议断言，不生成可执行步骤 |
| 管理 API | 文件存储 | 安全边界已加固；本机无登录；无数据库 |
| 试点用例 | 15 条已批准 | 登录页与工单必填校验已改强；`pilot-ticket-submit-success` 模板已入库（批准前需对齐级联/HTTP） |
| 弱断言 | 0 条 | 首页/列表/筛选/审阅弹窗可见；批准时强制拦截 |
| 本地验证 | 通过 | `pnpm verify`：typecheck + build + 测试 + 4 条 smoke |
| CI | 无（有意） | 用户要求不做自动 CI；本地 verify 为准 |
| LLM | 可选 | 1M max_tokens 透传；配置/运行错误在控制台可见 |

**必须诚实记录的事实：** `pilot-auto-ticket-no-attachment` 是「必填校验」负向用例。`pilot-ticket-submit-success.json` 提供成功路径模板，须在真实试点上校对级联文案与 HTTP 后再批准；练习环境由 `demo-ticket-submit-success` + smoke 证明。

## 2. 北极星与红线

**北极星：** 让测试人员用一句话或一次录制，得到一条**能被人工批准、能证明业务结果、能长期稳定运行**的测试资产。

不妥协项：

- **不许假绿**：每条试点用例必须有负向验证，证明条件不满足时会失败。
- **业务结果优先**：UI 文字与 HTTP 200 只是最低层证据；能查 DB、能查 agent 工具调用时，必须加业务断言。
- **回归零 LLM**：已批准用例的回放不调用模型。
- **密钥不进 IR、日志、LLM**：只通过 env ref / 配置引用解析。
- **审批绑定版本**：审批必须携带审阅时的 IR hash；配置变更也要可追溯。
- **本地优先**：默认只监听 127.0.0.1；不做 CI，除非用户明确要求。
- **证据可复现**：失败必须带 trace、network、截图或 DB/agent 证据。

## 3. 核心变革：可扩展断言引擎（Assertion Engine v2）

### 3.1 问题

当前断言在 `packages/assertions` 里用 switch 写死 UI/API 两种，`db`/`event` 直接返回未实现。业务真相通常在数据库、消息、对象存储、agent 工具调用里，继续堆 if/else 不可扩展。

### 3.2 目标

断言由 **Provider 注册表**驱动，IR 只描述「断言什么」，Provider 负责「怎么查、怎么判、怎么取证」。

支持并可配置的断言类型：

- `ui`：目标元素、可见性、数量、属性、URL、稳定文案；禁止整页弱文案。
- `http`：响应状态、响应体、JSON Schema、响应头、请求体；基于本次运行捕获的网络。
- `db`：只读连接、命名参数化查询、行存在/字段/数量/增量；禁止 IR 或 LLM 直写 SQL。
- `agent`：工具调用名称/参数/顺序/次数、禁止工具、耗时/token；基于 trace/telemetry。
- `event`：消息/事件按 correlationId 关联，显式超时与最终一致规则。
- `custom`：项目自定义 Provider，通过 SDK 注册。

### 3.3 IR 形状（向后兼容）

```json
{
  "id": "order-created-db",
  "type": "db",
  "provider": "postgres-readonly",
  "configRef": "pilot-db",
  "expect": {
    "queryRef": "order-by-run-id",
    "rowCount": 1,
    "row": { "status": "SUBMITTED" }
  },
  "oracle": "human-approved"
}
```

```json
{
  "id": "agent-used-search",
  "type": "agent",
  "provider": "otel-trace",
  "configRef": "agent-observability",
  "expect": {
    "traceRef": "run-id",
    "toolCalls": [
      { "name": "search_orders", "minCount": 1, "args": { "customerId": "run-id" } }
    ],
    "forbiddenTools": ["delete_order"]
  },
  "oracle": "human-approved"
}
```

### 3.4 Provider 契约

```ts
interface AssertionProvider {
  id: string;
  kind: "ui" | "http" | "db" | "agent" | "event" | "custom";
  validate(assertion: TestAssertion): ValidationIssue[];
  run(assertion: TestAssertion, ctx: AssertionContext): Promise<AssertionOutcome>;
  evidence?(outcome: AssertionOutcome): ArtifactRef[];
}
```

`AssertionContext` 提供 page、network、env、runId，以及按 `configRef` 解析出的 DB 客户端、trace 客户端、HTTP 捕获器。Provider 只能拿到自己需要的上下文。

### 3.5 配置与安全

- 连接、查询集、trace 源放在项目/环境配置里，通过 `configRef` 引用；IR 不存密钥。
- DB 只读账号；只允许命名查询、参数化变量、表和字段白名单；禁止任意 SQL。
- Agent trace 只读；按 runId/traceId 关联；工具参数可脱敏。
- 配置有版本/hash；审批时记录 IR hash + 配置版本，配置变化要求重新审阅。
- 每个 Provider 的 `expect` 有独立 schema；批准前校验。

### 3.6 配置与选择体验

Console 的断言编辑器需要支持：

- 选择断言类型 → 选择 Provider → 填写 `expect`。
- 配置引用选择（DB/trace 源）与「测试连接」。
- 预览：显示本次运行可用的网络条目、DB 查询结果样例、trace 中的工具调用。
- 保存前用 Provider schema 校验；弱断言/缺失配置直接阻止批准。

### 3.7 负向验证（硬门槛）

每个 Provider 必须有一组「能失败」的测试：

- UI：删除目标文案/元素 → 断言失败。
- HTTP：返回 500 或错误响应体 → 断言失败。
- DB：查询返回 0 行或错误字段 → 断言失败。
- Agent：trace 缺少指定工具调用/出现禁止工具 → 断言失败。
- 负向验证结果写入运行报告；没有负向验证的断言不得进入「已批准」。

## 4. 版本路线

| 版本 | 重点 | 明确不做 |
|---|---|---|
| V0.3 可信试点（当前） | 断言引擎 v2、真实业务断言、真实提交用例、负向验证、工作流正确性 | 多项目、RBAC、分布式调度 |
| V0.4 可重复回归 | 并行、flake 统计、证据保留、更多 Provider、GitLab 可选集成 | 全自动覆盖率推断 |
| V0.5 团队平台 | PostgreSQL、项目/环境、RBAC、调度、审计、看板、MR 门禁 | 移动端适配 |
| V1.0 开源/多端 | Docker、文档、插件 SDK、Android/iOS/Harmony/Glass Adapter、基准 | 一次性完成所有端 |

v0.2 的「V0.2 稳定回放 / V0.3 业务闭环」被吸收并重排：先补信任与断言引擎，再扩平台。

## 5. V0.3 任务清单（P0）

### 5.1 执行看板（每完成一项勾选，并附证据）

- [x] AS-1 Provider 注册表 + IR 扩展 — `pnpm verify` 全绿（2026-11-04）；`packages/assertions/src/providers.test.ts`（默认/显式 Provider、未知 Provider、db 缺 provider）；`packages/test-ir/src/validate.test.ts`（schema 接受 provider/configRef）；`services/test-management/src/approval.test.ts`（未知 Provider 审批 400）
- [x] AS-2 HTTP 断言 Provider — `pnpm verify` 全绿；`packages/assertions/src/captured-http.ts` + `captured-http.test.ts`（状态/请求体/响应体/响应头/JSON Schema 正负）；`packages/evidence` 捕获 `responseBody`/`responseHeaders` + `waitForNetworkCapture`
- [x] AS-3 DB 断言 Provider — `postgres-readonly` Provider + `docs/assertion-db-config.example.json` + `packages/fixtures` 只读客户端；`packages/assertions/src/postgres-readonly.test.ts`；审批未知 queryRef 400；`pnpm verify` 全绿
- [ ] AS-4 Agent 断言 Provider
- [ ] AS-5 断言配置 UI
- [ ] AS-6 负向验证框架
- [x] P-1 真实工单提交成功用例 — `selectCascader` 步骤 + `demo-ticket-submit-success.json`（UI+HTTP）+ `demo-ticket-no-attachment.json` 负向 + `runner-web/src/ticket-p1.test.ts`；试点模板 `pilot-ticket-submit-success.json`（draft，需人工校对后批准）；`pnpm verify` 全绿
- [ ] P-2 登录态 intake 快照
- [ ] P-3 Recorder 端到端
- [ ] P-4 步骤编辑器 / 草稿试跑
- [ ] P-5 审批身份与审计
- [ ] P-6 Flake 与重试策略
- [ ] P-7 文档与门禁

### 5.2 冲刺顺序

| 冲刺 | 内容 | 出口条件 |
|---|---|---|
| Sprint A（当前） | AS-1 注册表 + AS-2 HTTP + P-1 真实工单提交 | 工单测试能证明提交请求发生；HTTP 断言可配置；旧 UI 断言不回归 |
| Sprint B | AS-3 DB + AS-6 负向验证（UI/HTTP/DB） | 工单测试能查 DB 行；三类 Provider 各有预期失败用例 |
| Sprint C | AS-4 Agent + AS-5 配置 UI | 能配置 trace 源并断言工具调用；控制台可选择 Provider |
| Sprint D | P-2～P-7 工作流与门禁 | 登录态 intake、录制、步骤编辑、审批审计、flake、文档全绿 |

### 5.3 任务表

| ID | 任务 | 完成定义（DoD） |
|---|---|---|
| AS-1 | Provider 注册表 + IR 扩展 | 新增 `provider`/`configRef` 字段；旧 IR 仍可运行；注册表有单元测试 |
| AS-2 | HTTP 断言 Provider | 支持响应状态/响应体/JSON Schema/响应头/请求体；用捕获流量；正负测试 |
| AS-3 | DB 断言 Provider | 只读连接、命名参数化查询、行/字段/数量/增量断言；证据快照；禁止任意 SQL；正负测试 |
| AS-4 | Agent 断言 Provider | 支持 OTel/JSON trace 导入；工具调用名称/参数/次数/禁止工具；证据 traceId；正负测试 |
| AS-5 | 断言配置 UI | 类型/Provider/expect 选择、配置引用、测试连接、预览、保存校验 |
| AS-6 | 负向验证框架 | 每个 Provider 一条可复现的「预期失败」用例；报告可查 |
| P-1 | 真实工单提交成功用例 | 省/市/区县/街道级联选择；成功 UI + HTTP 提交 +（如有权限）DB 行插入；负向验证 |
| P-2 | 登录态 intake 快照 | `/api/intake` 对试点地址先登录再快照；不得静默抓登录页 |
| P-3 | Recorder 端到端 | 录制登录 → env ref 运行通过；IR 无明文 PII；select/cascader 支持或明确标注不支持 |
| P-4 | 步骤编辑器 / 草稿试跑 | 控制台可编辑/排序/删除步骤并试跑；批准仍绑定 hash |
| P-5 | 审批身份与审计 | `approvedBy` 来自可信身份/本地令牌；审计日志可查 |
| P-6 | Flake 与重试策略 | 记录 attempt；按失败分型重试；flake 率可见；断言失败不重试 |
| P-7 | 文档与门禁 | 更新路线图/README；移除过期 CI 描述；`pnpm verify` 全绿 |

**V0.3 发布门槛：**

- 10–20 条试点用例，其中 ≥70% 至少有一条 DB/HTTP/Agent 业务断言，而不是只有 UI 文案。
- 0 条弱断言；所有试点用例通过负向验证。
- 连续 3 次全量回归通过，flake 有记录。
- `pnpm verify` 全绿；安全回归测试全过。
- 控制台能完成：选择断言类型 → 配置 Provider → 预览 → 批准 → 运行 → 看证据。

## 6. V0.4 / V0.5 / V1.0 摘要

| 版本 | 任务 |
|---|---|
| V0.4 | 并行 suite、flake 看板、证据保留策略、MySQL/SQL Server/事件总线/对象存储 Provider、GitLab MR 集成（可选） |
| V0.5 | PostgreSQL、项目/环境模型、RBAC、调度器、审计日志、趋势看板、MR 门禁 |
| V1.0 | Docker、插件 SDK、开放 Provider 规范、Android/iOS/Harmony/Glass Adapter、可靠性 benchmark |

## 7. Cursor 工作协议

- 一次只做一个垂直切片；任务来自本路线图的 ID，不自行扩大范围。
- 开始前写清楚：改哪些文件、如何验证、验收标准对应哪一条。
- 每个改动必须带测试；UI 改动必须在浏览器实际看过并截图/记录。
- 提交前运行 `pnpm verify`；失败就修，不允许跳过或弱化测试。
- 不自动批准用例；不删除/放宽弱断言门禁；不改安全默认值（CORS/令牌/白名单）。
- 不把密钥、`.env`、真实凭据写入代码、日志、IR、LLM prompt。
- 不为了让测试通过而改断言；必须先确认业务行为。
- 不添加 CI、数据库、队列等基础设施，除非该版本任务明确要求且用户同意。
- 完成后报告：改了什么、证据、未验证的部分、下一步。

## 8. Claude 把关节奏

在以下节点必须 review：

- 每个 P0 任务完成时。
- 任何安全、审批、断言引擎、执行器改动。
- 任何声称「完成」的里程碑。

Review 清单：

- 安全：路径穿越、CORS、SSRF、令牌、密钥泄露。
- 信任：审批 hash、配置版本、弱断言、负向验证。
- 正确性：目标 URL、凭据解析、步骤真的执行、断言真的能失败。
- 证据：trace/network/DB/agent 证据可下载、可关联 runId。
- 流程：`pnpm verify` 绿、文档准确、没有把未验证说成已完成。

**Stop the line：** 发现路径穿越、密钥泄露、假绿、审批绕过、把未验证说成完成，立即停止并修复，不进入下一项。

## 9. 验收指标

| 指标 | V0.3 目标 | 测量方式 |
|---|---|---|
| 弱断言 | 0 | `/api/metrics/summary.weakApprovedCount` |
| 业务断言覆盖 | ≥70% 试点用例 | 每条用例至少一个 DB/HTTP/Agent 断言 |
| 负向验证覆盖 | 100% 试点用例 | 负向运行报告 |
| 假绿事故 | 0 | 评审发现的「通过但未发生业务效果」 |
| 全量回归成功率 | ≥95% | 连续 3 次以上 |
| Flake 率 | <5% | 同用例重复运行的失败率 |
| 本地门禁 | 100% 绿 | `pnpm verify` |
| 人工节省 | 相对基线 ≥50% | 手工耗时基线 vs 回归 + 维护时间 |

## 10. 风险与决策

| 风险 | 处理 |
|---|---|
| DB/Agent 配置复杂、密钥多 | 配置引用 + env ref；测试连接；最小权限 |
| DB schema 变化导致断言脆弱 | 命名查询版本化；配置 hash；失败分型 |
| Agent trace 来源不统一 | 先支持 OTel/JSON trace；Provider SDK 扩展 |
| 级联选择器易变 | 语义 locator + 目标断言；必要时录制 |
| 远程试点环境不稳定 | 失败分型、有限重试、证据保留 |
| Cursor 过度实现/虚报完成 | 路线图任务制 + Claude 评审门禁 + 负向验证 |
| 无 CI | 本地 `pnpm verify` 作为硬门槛；需要时再评估 CI |

**新增 ADR：**

- ADR-006：可扩展断言引擎与 Provider 契约（已落：[`docs/adr/ADR-006-extensible-assertions.md`](docs/adr/ADR-006-extensible-assertions.md)）。
- ADR-007：断言配置版本、审批 hash 与审计（待补）。
- ADR-008：安全默认值（本机绑定、CORS 白名单、目标白名单、令牌）（待补）。
- ADR-009：AI 只建议不自动改；回归零 LLM（待补）。
- ADR-010：本地门禁优先，CI 按需（待补）。

## 11. 附录

### 11.1 常用命令

```bash
pnpm install
pnpm dev
pnpm verify
pnpm --filter @testpilot/test-management exec playwright install chromium
```

### 11.2 环境变量

- `TESTPILOT_PILOT_BASE_URL`
- `TESTPILOT_ENV_ADMIN_PHONE`
- `TESTPILOT_ENV_ADMIN_PASSWORD`
- `TESTPILOT_LLM_*`
- `TESTPILOT_API_TOKEN`（非本机绑定时必填）
- `TESTPILOT_ALLOWED_ORIGINS`
- `TESTPILOT_ALLOWED_TARGETS`

### 11.3 当前已知缺口

- 真实工单提交成功：练习环境已覆盖；试点 IR 模板已入库，待人工对齐级联/HTTP 后批准。
- Recorder 未验证 select/cascader；复杂表单仍需手工补步。
- 控制台不能编辑步骤。
- 无 DB/Agent 断言 Provider。
- 无 PostgreSQL/多项目/RBAC。
- 无自动 CI（按用户要求）。

### 11.4 证据要求

每个 P0 任务完成时，必须附：

- 变更文件列表。
- `pnpm verify` 输出。
- 正向与负向运行结果。
- Trace/network/DB/agent 证据路径。
- 未验证项与风险。

---

**一句话：v0.3 不追求更多页面和更多按钮，追求「每条通过的测试都能证明业务真的发生了」。**

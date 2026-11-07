# TestPilot 执行路线图 v0.3

## 从「能演示」到「能信任、能证明业务结果」

**2026-11-06 · V0.3 完成，V0.4（可重复回归）已规划 · Cursor 执行，Claude 定期把关**

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
| Web recorder | 已验证（P-3） | 密码/手机号/PII → env/fixture ref；真实浏览器录制测试 `recorded-session.test.ts`；原生 select 录为 `select` 步骤；cascader 仍需手工补 `selectCascader` |
| Console | 可用 | 步骤编辑/草稿试跑（试跑不计入回归指标）、Provider 审阅面板、审批身份与审计、删除草稿、弱断言门禁 |
| Planner | 规则式 + 可选 LLM | 否定词已修；LLM 只建议断言，不生成可执行步骤 |
| 管理 API | 文件存储 | 安全边界已加固；本机无登录；无数据库 |
| 试点用例 | 15 条已批准 | 登录页与工单必填校验已改强；`pilot-ticket-submit-success` 模板已入库（批准前需对齐级联/HTTP） |
| 断言引擎 | 可用 | UI / captured-http / postgres-readonly / otel-trace Provider；负向探针 4 路 |
| 弱断言 | 0 条 | 首页/列表/筛选/审阅弹窗可见；批准时强制拦截 |
| 本地验证 | 通过 | `pnpm verify`（见 [`docs/LOCAL-GATE.md`](docs/LOCAL-GATE.md)）；含 IR 校验、单元测试、demo smoke、负向探针 |
| 全量回归 | 16/16 通过 | 2026-11-06 控制台「运行全部回归」实跑，含 4 条试点用例；单次 pilot 登录超时归为 `ENVIRONMENT` 并已由重试策略覆盖 |
| CI | 无（有意） | 无 `.github/workflows`；[`docs/LOCAL-GATE.md`](docs/LOCAL-GATE.md) 为唯一门禁说明 |
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
| V0.3 可信试点（已完成） | 断言引擎 v2、真实业务断言、真实提交用例、负向验证、工作流正确性 | 多项目、RBAC、分布式调度 |
| V0.4 可重复回归（当前） | 显式批次与并行、flake 统计与看板、运行详情页、证据保留/清理、试点成功用例业务化、连续 3 批基线 | Provider 扩展、GitLab/CI、PostgreSQL、RBAC、调度 |
| V0.5 团队平台 | PostgreSQL、项目/环境、RBAC、调度、审计、趋势看板、Provider 扩展（MySQL/SQL Server/事件/对象存储） | 移动端适配 |
| V1.0 开源/多端 | Docker、文档、插件 SDK、Android/iOS/Harmony/Glass Adapter、基准 | 一次性完成所有端 |

v0.2 的「V0.2 稳定回放 / V0.3 业务闭环」被吸收并重排：先补信任与断言引擎，再扩平台。

## 5. V0.3 任务清单（P0）

### 5.1 执行看板（每完成一项勾选，并附证据）

- [x] AS-1 Provider 注册表 + IR 扩展 — `pnpm verify` 全绿（2026-11-04）；`packages/assertions/src/providers.test.ts`（默认/显式 Provider、未知 Provider、db 缺 provider）；`packages/test-ir/src/validate.test.ts`（schema 接受 provider/configRef）；`services/test-management/src/approval.test.ts`（未知 Provider 审批 400）
- [x] AS-2 HTTP 断言 Provider — `pnpm verify` 全绿；`packages/assertions/src/captured-http.ts` + `captured-http.test.ts`（状态/请求体/响应体/响应头/JSON Schema 正负）；`packages/evidence` 捕获 `responseBody`/`responseHeaders` + `waitForNetworkCapture`
- [x] AS-3 DB 断言 Provider — `postgres-readonly` Provider + `docs/assertion-db-config.example.json` + `packages/fixtures` 只读客户端；`packages/assertions/src/postgres-readonly.test.ts`；审批未知 queryRef 400；`pnpm verify` 全绿
- [x] AS-4 Agent 断言 Provider — `otel-trace` Provider + `docs/assertion-agent-config.example.json` + `packages/fixtures` trace 客户端（canonical + OTLP JSON）；`packages/assertions/src/otel-trace.test.ts`；负向探针 `otel-trace-probe.json`；`pnpm verify` 全绿
- [x] AS-5 断言配置 UI — 审阅弹窗 Provider 面板（类型/configRef/expect、校验·测试连接·预览）；API `GET /api/assertions/providers|config-catalog`、`POST validate|test-connection|preview`；保存 IR 时 Provider 校验；`assertion-config.test.ts`；`pnpm verify` 全绿
- [x] AS-6 负向验证框架 — `examples/negative-probes/*` + `pnpm negative-probes` → `artifacts/negative-probes-last.json`；`GET /api/metrics/negative-probes`；`pnpm verify` 全绿
- [x] P-1 真实工单提交成功用例 — `selectCascader` 步骤 + `demo-ticket-submit-success.json`（UI+HTTP）+ `demo-ticket-no-attachment.json` 负向 + `runner-web/src/ticket-p1.test.ts`；试点模板 `pilot-ticket-submit-success.json`（draft，需人工校对后批准）；`pnpm verify` 全绿
- [x] FIX-1 HTTP 断言必须可失败 — `captured-http-expect.ts` 白名单 expect；空 expect / 仅 requestRef 运行时 `ASSERTION_ORACLE`；审批拒绝未知字段、空 schema、空字符串与未知 JSON Schema 关键字；合法 `responseJsonSchema` 可审批；`partialJsonMatch` 严格类型并支持数组深匹配；`captured-http.test.ts` / `approval.test.ts` 正负测试；`pnpm verify` 全绿
- [x] FIX-0 AS-4 OTLP 工具 span 过滤 — `trace-client.ts` 按 `service.name` + 工具属性识别；HTTP span 排除；多 trace 按 traceRef 选择；`examples/agent-traces/run-1.json` + `otel-trace.test.ts`；`pnpm verify` 全绿
- [x] FIX-2 DB 只读边界 — `assertSafeReadonlySql` 增强；DB expect 白名单 + 必须 rowCount/minRowCount/row；连接错误 `ENVIRONMENT`；删除 fixtures self-dependency；`postgres-readonly.test.ts` 负向；`pnpm verify` 全绿
- [x] FIX-3 证据脱敏 — `packages/evidence/src/redact.ts`；network.json / DB / agent actual 脱敏；`redact.test.ts`；`pnpm verify` 全绿
- [x] FIX-4 配置版本绑定 — `computeAssertionConfigHash`；审批 `assertionConfigHash` 409；控制台审阅展示；`approval.test.ts`；`pnpm verify` 全绿
- [x] FIX-5 负向探针门禁 — 仅 `PRODUCT_DEFECT` 算成功；报告 `errorKind`；metrics 测试用临时 artifacts；`negative-probes.mjs` / `ticket-p1.test.ts` 轮询就绪；`pnpm verify` 全绿
- [x] FIX-6 P-1 负向与试点 — `absent`/`requestCount:0` HTTP 断言；`demo-ticket-no-attachment` 无 201；`pilot-ticket-no-region.json` 草稿；`env.ticketPhone`；`pnpm verify` 全绿
- [x] FIX-7 清理 — Provider 重复注册抛错；URL 路径级匹配；`url-path-match.test.ts` / `providers.test.ts`；`pnpm verify` 全绿
- [x] R-1 HTTP 断言 actual 脱敏 — `captured-http.ts` 经 `redactForEvidence` 输出 actual；`run.ts` 二次防护；`redact.ts` 强化 requestBodies/responseJson；expected/message 也经 `redactStrings`/`redactStringBody`；`captured-http.test.ts` 正负（PII 匹配仍通过、actual/expected/失败消息无明文）；smoke `artifacts/smoke-last.json` 中 `requestBodies`/`requestJson` 为 `***`；`pnpm verify` 全绿（2026-11-06）
- [x] R-2 DB guard 逗号 join + schema — `readonly-db-client.ts` 改用 `pgsql-ast-parser` 提取所有表引用，覆盖逗号列表、子查询、CROSS JOIN 子查询、引号表名、WHERE 子查询与 schema 前缀；`postgres-readonly.test.ts` 正负；`pnpm verify` 全绿（2026-11-06）
- [x] R-3 Pilot 负向用例 seed — `seed-pilot-catalog.json` + `pilot-ticket-no-region.json` wait alert；`seed.test.ts`；`pnpm verify` 全绿（2026-11-06）
- [x] R-4 配置 hash 与缓存 — `config-hash` 注册失效；db/agent loader 按 `computeAssertionConfigHash` 刷新；`config-hash.test.ts` + `approval.test.ts` 409；`pnpm verify` 全绿（2026-11-06）
- [x] R-5 absent/requestCount — `captured-http.test.ts` provider 级正负 + 审批 shape 拒绝 `absent:false`/`requestCount:1`；`pnpm verify` 全绿（2026-11-06）
- [x] R-6 脱敏表单/纯文本/URL — `redact.ts` + `redact.test.ts`；`pnpm verify` 全绿（2026-11-06）
- [x] R-7 负向探针 assertion id — `expectedAssertionId` + `negative-probes.test.ts` + `probe-catalog.json`；`pnpm verify` 全绿（2026-11-06）
- [x] R-8 启动清理 + AS-4 service — `negative-probes.mjs` / `ticket-p1.test.ts` try/finally；`trace-client.ts` 缺 `service.name` 跳过 + `trace-client.test.ts`；`pnpm verify` 全绿（2026-11-06）
- [x] P-2 登录态 intake 快照 — `pilot-intake-snapshot.ts`（试点 URL 先登录再导航/快照）；`loginPath` 从 `pilot-baseline.json` 读取，选择器兼容中英文；`/api/intake` 缺凭据 400、登录页 422；`pilot-intake-snapshot.test.ts`；`pnpm verify` 全绿
- [x] P-3 Recorder 端到端 — `recorded-session.test.ts` 真正驱动浏览器录制（注入脚本已可解析，修复 `as const` 语法错误）；密码/手机号 → env ref，邮箱/手机号/证件号 → fixture ref；原生 select 录为 `select` 步骤；cascader warning；`recorded-login-p3.test.ts` 回放；`pnpm verify` 全绿
- [x] P-4 步骤编辑器 / 草稿试跑 — `@testpilot/test-ir/step-edit`；控制台步骤编辑（上移/下移/编辑/删除/添加）、草稿试跑与试跑证据；试跑记录标记 `trial` 且不计入回归指标；批准仍绑定 `irHash`；`trial-run.test.ts`；`pnpm verify` 全绿
- [x] P-5 审批身份与审计 — `TESTPILOT_APPROVAL_TOKEN` / `TESTPILOT_APPROVAL_ACTORS`；`GET /api/audit` + `audit.jsonl`；控制台「审计」页与审阅内联身份；审计写入失败不影响已保存的批准；`approval-identity.test.ts`；`pnpm verify` 全绿
- [x] P-6 Flake 与重试策略 — 修复 `failureKind` 从 `metrics` 读取、Playwright `Timeout` 大小写分类、legacy `attempts` 无 `on` 时默认重试 `ENVIRONMENT`；断言失败不重试；`retry-policy.test.ts` / `retry-integration.test.ts` / `flake-metrics.test.ts`；`pnpm verify` 全绿
- [x] P-7 文档与门禁 — `docs/LOCAL-GATE.md`；README/ROADMAP 基线与缺口同步；移除「former GitHub workflow」等过期 CI 表述；`pnpm verify` 全绿

### 5.2 冲刺顺序

| 冲刺 | 内容 | 出口条件 |
|---|---|---|
| Sprint A（当前） | AS-1 注册表 + AS-2 HTTP + P-1 真实工单提交 | 工单测试能证明提交请求发生；HTTP 断言可配置；旧 UI 断言不回归 |
| Sprint B | AS-3 DB + AS-6 负向验证（UI/HTTP/DB） | 工单测试能查 DB 行；三类 Provider 各有预期失败用例 |
| Sprint C | AS-4 Agent + AS-5 配置 UI | 能配置 trace 源并断言工具调用；控制台可选择 Provider |
| Sprint D | P-2～P-7 工作流与门禁 | **已完成**（2026-11-06）：intake/录制/步骤编辑/审批审计/flake/文档；出口 `pnpm verify` 全绿 |

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
| V0.4 | 显式批次与并行、flake 统计与看板、运行详情页、证据保留策略、试点成功用例业务化、连续 3 批基线（Provider 扩展移到 V0.5） |
| V0.5 | PostgreSQL、项目/环境模型、RBAC、调度器、趋势看板、Provider 扩展（MySQL/SQL Server/事件总线/对象存储） |
| V1.0 | Docker、插件 SDK、开放 Provider 规范、Android/iOS/Harmony/Glass Adapter、可靠性 benchmark |

### 6.1 V0.4 任务清单（可重复回归）

**执行看板**

- [x] V4-1 显式批次与并行执行 — `batchId`/`batchStartedAt`、`data/batches/`、`GET /api/batches`；`TESTPILOT_MAX_PARALLEL`（默认 2、上限 4）并行批跑；单跑不写 batch、指标仅显式批次；`batch-parallel` / `explicit-batch` / `batch-metrics` 测试；`pnpm verify` 全绿
- [ ] V4-2 Flake 统计与看板
- [ ] V4-3 运行详情页
- [ ] V4-4 证据保留与清理
- [ ] V4-5 试点成功用例业务化
- [ ] V4-6 连续 3 批基线
- [ ] V4-7 文档与门禁

**目标：** 从「能跑一次」到「敢天天跑」——批次可追踪、失败可定位、flake 可见、证据不失控。

| ID | 任务 | 完成定义（DoD） |
|---|---|---|
| V4-1 | 显式批次与并行执行 | `StoredRun` 增加 `batchId` / `batchStartedAt`；批量接口返回批次对象；并行度由 `TESTPILOT_MAX_PARALLEL` 控制（默认 2，上限 4）；每个 run 独立 artifacts 目录；手工单跑不再被时间窗口并入批次；测试覆盖并发隔离、单条失败不阻塞其余 |
| V4-2 | Flake 统计与看板 | 支持 `repeatCount`（默认 1；flake 检查用 3）重复运行；按测试输出 flake 率、重试恢复数、failureKind 分布；断言失败不计入 flake；`GET /api/metrics/flake` + 控制台可见；正负测试（故意 flake 与确定性失败） |
| V4-3 | 运行详情页 | 控制台单页展示步骤时间线、断言 expected/actual（已脱敏）、attempt、failureKind、batch 链接、trace/network/截图/DB/agent 证据链接；缺失证据显示「未生成」而非死链；浏览器实看 |
| V4-4 | 证据保留与清理 | 保留策略（按批次数/天数/总大小）；`pnpm clean:artifacts --keep-batches K --days N` 默认 dry-run；只删 `artifacts/`，绝不动 `data/tests`、`data/runs` 的 IR 与审批；批次 manifest 记录大小；临时目录测试覆盖 |
| V4-5 | 试点成功用例业务化 | 在真实试点对齐 `pilot-ticket-submit-success` 的级联/HTTP（只读探索 + 草案；真实批准由用户执行）；有 DB 配置时加只读 DB 行断言；探针证明可失败；不得自动批准 |
| V4-6 | 连续 3 批基线 | 连续 3 次全量回归使用显式批次；记录通过率、flake、耗时；目标通过率 ≥95%、flake <5%；结果写入报告并在控制台可见 |
| V4-7 | 文档与门禁 | 更新 ROADMAP/README/LOCAL-GATE；写明并行度与保留策略；无 CI；`pnpm verify` 全绿 |

**V0.4 发布门槛：**

- `pnpm verify` 全绿；安全回归测试全过。
- 连续 3 批显式批次全量回归，通过率 ≥95%，flake <5%。
- 控制台能：看批次 → 进运行详情 → 看失败分型/断言/证据 → 判断是产品缺陷还是环境问题。
- 证据清理在临时目录验证过，dry-run 不删除任何内容。
- 无新增明文 PII、无弱化审批/弱断言门禁、无自动批准。

**明确不做（V0.5 或用户明确要求再做）：**

- MySQL / SQL Server / 事件总线 / 对象存储 Provider。
- GitLab MR / CI 集成（用户明确不要自动 CI）。
- PostgreSQL 持久化、多项目、RBAC、调度器、Docker。
- 修改安全默认值、审批语义、弱断言门禁。

**Cursor 执行规则（V0.4 专用）：**

- 按 V4-1 → V4-7 顺序做；每个任务单独 commit（`V4-1: ...`），提交前 `pnpm verify` 必须绿。
- 一次会话内可以连续做完全部任务，但**不许攒成一个巨型提交**；每个 commit 必须能独立回滚。
- 遇到以下情况必须停下报告，不许自行决定：IR/schema 变更、安全边界、审批语义、需要改真实试点数据、无法写出「能失败」的测试。
- 不自动批准用例；不删除/放宽弱断言门禁；不把未验证项写成完成。
- 完成后提交交接报告：每个任务的 commit、`pnpm verify` 输出、浏览器截图/证据路径、未验证项。

## 7. Cursor 工作协议

- 一次只做一个垂直切片；任务来自本路线图的 ID，不自行扩大范围。V0.4 允许同一会话连续完成多个任务，但每个任务必须单独 commit、单独验证。
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
| Flake 率 | <5% | `/api/metrics/summary.flakeRecoveryRate`、运行 `attemptCount` |
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
- ADR-007：断言配置版本、审批 hash 与审计（P-5 审计与 `assertionConfigHash` 已落地；完整 ADR 待补）。
- ADR-008：安全默认值（本机绑定、CORS 白名单、目标白名单、令牌）（待补）。
- ADR-009：AI 只建议不自动改；回归零 LLM（待补）。
- ADR-010：本地门禁优先，CI 按需（待补）。

## 11. 附录

### 11.1 常用命令

```bash
pnpm install
pnpm dev
pnpm verify          # 见 docs/LOCAL-GATE.md；demo :4173 需可达
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
- `TESTPILOT_APPROVAL_TOKEN` / `TESTPILOT_APPROVAL_ACTORS`（可选，批准身份）

完整说明见 `.env.example`。

### 11.3 当前已知缺口

- 试点「工单提交成功」：练习环境已覆盖；`pilot-ticket-submit-success` 模板须在真实试点上校对级联/HTTP 后再批准。
- 原生 select 已支持录制/回放；cascader 录制仍只给 warning，需手工补 `selectCascader` 步骤。
- 回归批次按显式 `batchId` 聚合；手工单跑不写 batchId，不进入批次统计（V4-1）。
- 无 PostgreSQL 持久化 / 多项目 / RBAC / 远程 CI（按路线后续版本）。

### 11.4 证据要求

每个 P0 任务完成时，必须附：

- 变更文件列表。
- `pnpm verify` 输出。
- 正向与负向运行结果。
- Trace/network/DB/agent 证据路径。
- 未验证项与风险。

---

**一句话：v0.3 不追求更多页面和更多按钮，追求「每条通过的测试都能证明业务真的发生了」。**

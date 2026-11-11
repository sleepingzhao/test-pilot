# TestPilot 执行路线图 v0.7.5

## 从「能演示」到「能信任、能证明业务结果」，再到「能发现系统能力」

**2026-11-10 · V0.7 接口直连 / 文件媒体 / WS 管道完成；V0.7.5「业务接入就绪」为下一阶段 · Cursor 执行，Claude 定期把关**

> **唯一执行计划。** 原 `docs/BACKLOG.md` 已合并到本文件；`design/` 下的 v0.2 路线 docx 已删除，仅保留架构/概念图。状态只在本文件维护，不要另建待办文件。

## 0. 为什么重规划

v0.2 是架构草案，功能面铺得宽，但没有回答三个问题：什么算真正完成、什么不能上线、如何证明测试不是假绿。

2026-11-04 的代码评审确认了三个短板：

- **安全边界**：artifacts 路径穿越、CORS 任意源、无鉴权、SSRF 目标。已修复并有回归测试。
- **信任机制**：IR hash 对嵌套内容不敏感、审批不绑定版本、弱断言可被批准、catalog 变更可绕过复审。已修复。
- **断言质量**：旧的工单测试只断言页面出现「工单」，实际点击后只出现了「请选择省、市、区县和街道」提示，网络里没有提交请求，属于假阳性。

因此 v0.3 的第一目标不是加功能，而是：**让每条已批准的测试都能失败、都能证明业务结果，并且让扩展新断言类型成为配置工作，而不是改 runner 代码。**

## 0.1 方向、进度与架构对齐（2026-11-10）

**当前方向：Web 业务系统优先。** 先把「测试人员安全接入一个业务系统 → 生成/审阅用例 → 跑出可信证据 → 清理测试数据」做通。移动端、CI、多项目/RBAC、平台化暂不投入；实时与 Agent 在业务接入闭环之后继续。

**当前唯一开工任务：V7-5e 机制接线。** V7-9a 已验收（2026-11-12）；随后 V7-6b → V7-0i，再回到 V7-9b 生成期视觉定位（DeepSeek Flash 已支持图像理解，可复用现有 OpenAI 兼容端点）。视觉能力边界见 [ADR-011](docs/adr/ADR-011-midscene-visual-assist.md)：视觉只用于生成期与证据期，已批准回归保持零 LLM。

**本阶段要证明的事：** 一条业务系统的正常功能回归，可以被人审阅、能在失败时给出证据、能在通过后不留下脏数据。

### 架构图对照

| 架构层 | 当前状态 | 结论 / 缺口 |
|---|---|---|
| Web Console / CLI / CI | Console 可用；CLI `validate` / `run` / `record` 可用；CI 无（有意） | 主干对齐；CI 后置 |
| Test Intelligence Layer | LLM Provider、Context Engine、失败诊断可用；Test Generator 覆盖需求→草稿与能力探测 | 风险分析、主动场景探索未做；机制包尚未接入生成链路 |
| Test IR + Assertion Engine | IR v1；navigate/click/fill/press/wait/select/selectCascader/request/upload；`policy.cleanup` + `teardownSteps`；5 个断言 Provider（ui / captured-http / postgres-readonly / otel-trace / ws）；负向探针 5 路 | 核心最强；数据隔离/自动生成仍缺；自修复仅建议 |
| 平台层 | Web（Playwright）可用；Android / iOS / Harmony 仅有类型占位 | 与架构图差距最大，后置 |
| Execution & Observability | 批次调度、并发、恢复、Trace / network / screenshot / ws 证据、步骤截图时间线与失败直达、测试数据清理、flake、基线可用 | WS 证据无控制台入口；CI 未接 |

概念图输入侧：自然语言 / PRD ✓、人工录制 ✓、**OpenAPI ✗**、**Git Diff ✗**。探索模式目前只有结构化采集 + 能力探测；视觉探索按 [ADR-011](docs/adr/ADR-011-midscene-visual-assist.md) 后置到 V7-9c，且不参与回归门禁。

### 已完成（截至 2026-11-12）

- V0.3–V0.6：断言 Provider、可信批次、需求→草稿→试跑→审批、能力探测（规则 + LLM）与系统画像。
- V7-0：`request` 步骤、登录 Cookie 复用、模板变量、`stepRef` 断言绑定、控制台「接口测试」模式。
- V7-5：`upload` 步骤、demo `/files`、`planFileMedia` 机制包、故障注入负向验证。
- V7-1a / V7-3a / V7-6a：WS 收发帧证据、`ws` 断言 Provider、demo `/chat`、`drop` 负向验证。
- V7-7：`policy.cleanup` + `teardownSteps`、失败也清理、清理结果入 `RunResult.cleanup`、控制台审阅/运行详情、接口模式清理请求、demo `/api/items` 端到端清理用例。
- V7-0f / V7-0h：命名 API 环境（`api-envs.json`、`allowWrite`、环境头合并）与 cURL 本地解析导入；只读环境只允许 GET/HEAD。
- V7-9a：借鉴 Midscene 的步骤截图时间线（`screenshots: "always"`）、manifest `stepScreenshots`、控制台缩略图与「跳到失败步骤」；回归仍零 LLM。
- 当前控制台：17 条已批准用例（16 demo + 1 pilot），弱断言 0；`pnpm verify` 全绿；负向探针 5 个 Provider。

### 未完成 / 明确后置

- **P0（V0.7.5）**：机制包接线、WS 证据入口、OpenAPI 导入。
- **P1**：多账号 `actors`、realtime 机制包、SSE 证据、生成期视觉定位建议（V7-9b，DeepSeek Flash 支持图像理解）。
- **P2**：Agent 语义断言与 `llm-judge`、风险分析、主动探索、探索模式视觉判定（V7-9c，不进门禁）。
- **后置**：Android / iOS / Harmony、CI、多项目 / RBAC、自动修复。

### 下一里程碑：V0.7.5 业务接入就绪

**目标：** 测试人员能在明确授权的环境里，对一个业务系统跑通「创建 → 断言 → 清理」的完整回归，且不留下脏数据。

**执行顺序：**

- [x] **V7-7 测试数据生命周期**（2026-11-11 完成）：teardown 步骤、失败也清理、清理结果入证据、审批绑定 teardown。
- [x] 1. **V7-0f 命名 API 环境与鉴权头**（2026-11-11）：`api-envs.json` + `allowWrite` + `GET /api/api-envs` + 控制台选择器；`api-envs.ts` / `api-envs.test.ts` / `api-test-route.test.ts`；`pnpm verify` 全绿；浏览器：只读环境仅 GET/HEAD、无 header 值泄漏。
- [x] 2. **V7-0h cURL 导入**（2026-11-11）：`@testpilot/test-ir/curl-import` 本地解析；控制台「从 cURL 导入」预填表单；鉴权头/` -u`/`--oauth2-bearer` 丢弃并警告；`curl-import.test.ts`；`pnpm verify` 全绿；Playwright 浏览器：`/api/items` + `Authorization: Bearer SECRET123` → 选 `local-demo-ro`、path `/api/items`、请求头仅 `Accept`、警告含 Authorization 名且无密钥；只读环境 POST→GET + 警告；非法输入 `看起来不是 cURL 命令` 且不改动表单。
- [ ] 3. **V7-5e 机制接线**：画像 → `planFileMedia` → 控制台生成草稿；无能力时显示 blockers。
- [ ] 4. **V7-6b WS 证据入口**：运行详情可打开 `ws.json`，显示收发帧摘要。
- [ ] 5. **V7-0i OpenAPI 导入**：OpenAPI 3.x（JSON/YAML）选 operation → 预填接口用例。

### 借鉴 Midscene（2026-11-12，[ADR-011](docs/adr/ADR-011-midscene-visual-assist.md)）

**原则：视觉只用于生成期与证据期；已批准回归保持零 LLM。**

- [x] **V7-9a 步骤截图时间线与失败回放**（2026-11-12）：`policy.screenshots: "always"` 每步落 `step-<NN>-<stepId>.png` 并记入 `StepResult.screenshot` 与 manifest `stepScreenshots`；截图失败不把通过步骤变成失败；控制台时间线缩略图、点击看原图、「跳到失败步骤」；`on-failure` / `never` 不变；`step-screenshots.test.ts`（evidence 18、runner 50）覆盖三种策略与失败步骤；浏览器实测 2 步通过用例两张缩略图、失败运行跳转生效；`pnpm verify` 全绿。
- [ ] **V7-9b 生成期视觉定位建议（P1）**：截图 + 裁剪 ARIA 发给视觉模型，返回 1–3 个 locator 候选与包围盒；人工选定后写入 IR，运行时零模型调用；建议缓存只作为候选；试点/真实环境默认关闭。
- [ ] **V7-9c 探索模式视觉判定（P2）**：视觉问答只作为探索/诊断建议与证据，标 `oracle: "ai-suggested"`；不参与回归通过/失败门禁；不缓存判定结果。

**验收标准：**

- 一条写业务数据的用例：通过时 teardown 删除数据；断言失败时 teardown 仍执行；清理失败单独标记，不掩盖产品缺陷。
- 试点/真实环境没有 `allowWrite` 时只能发 GET/HEAD；真实环境默认仍只读。
- 接口用例可从 cURL 或 OpenAPI operation 生成，必须人工审阅批准，不自动批准。
- 控制台能显示「该环境可用的机制 / 缺什么前置条件」，而不是只给能力百分比。
- `pnpm verify` 全绿；UI 改动在浏览器实际验证。

## 1. 当前基线

| 能力 | 状态 | 证据 / 缺口 |
|---|---|---|
| Test IR v1 | 可用 | schema、validator、per-test baseUrl、IR hash v2；动作含 request / upload |
| Web runner | 可用 | 步骤机、重试、定位回退、trace/network/screenshot/ws 证据 |
| Web recorder | 已验证（P-3） | 密码/手机号/PII → env/fixture ref；真实浏览器录制测试 `recorded-session.test.ts`；原生 select 录为 `select` 步骤；cascader 仍需手工补 `selectCascader` |
| Console | 可用 | 需求生成、接口测试、步骤编辑、草稿试跑、Provider 审阅、审批身份与审计、弱断言门禁 |
| Planner | 规则式 + 可选 LLM | 规则模板 + LLM 步骤（快照校验）；表单探索可采集弹窗字段/下拉；能力探测已接入系统画像 |
| 能力探测（Detect） | 可用（V0.6） | `packages/detect` 采集器 + 八类规则 + LLM 能力分析 + `/api/detect` + 系统画像；真实环境 LLM 发现小智 Agent、工具市场、MCP、技能、记忆、设备控制；执行侧机制包尚未接线 |
| API 直连 | 可用（V7-0） | `request` 步骤、登录 Cookie 复用、`{{runId}}` / `{{var}}` / `{{env.KEY}}`、`saveAs` / `saveFields`、`stepRef` 断言；控制台「接口测试」生成草稿并试跑 |
| 文件/媒体 | 可用（V7-5） | `upload` 步骤 + fixture 目录约束；demo `/files`；`planFileMedia` 生成正常/类型/大小场景；负向故障注入 |
| 测试数据清理 | 可用（V7-7） | `policy.cleanup` + `teardownSteps`；通过/失败都清理；清理失败单独标记 `TEST_DATA`；控制台审阅/运行详情/接口模式均可配置 |
| 实时/富媒体证据 | 部分（V7-1a / V7-3a / V7-6a） | WS 收发帧、`ws.json`、`ws` 断言、demo `/chat` 已完成；SSE、多账号 A→B、重连/顺序/去重未做 |
| Agent 语义断言 | 部分（V0.8） | OTel trace 工具调用断言已有；无幻觉 rubric / LLM judge |
| 管理 API | 文件存储 | 安全边界已加固；本机无登录；无数据库 |
| 试点用例 | 16 条已批准（15 demo + 1 pilot） | 弱断言 0；`pilot-ticket-submit-success` 仍须在真实试点校对后批准 |
| 断言引擎 | 可用 | UI / captured-http / postgres-readonly / otel-trace / ws 共 5 个 Provider；负向探针 5 路 |
| 弱断言 | 0 条 | 首页/列表/筛选/审阅弹窗可见；批准时强制拦截 |
| 本地验证 | 通过 | `pnpm verify`（见 [`docs/LOCAL-GATE.md`](docs/LOCAL-GATE.md)）；含 IR 校验、单元测试、demo smoke、负向探针 |
| 全量回归 | 以最近批次为准 | 2026-11-10 控制台为 16 条已批准；近期无新的显式全量批次，跑完再更新 flake/基线数字 |
| CI | 无（有意） | 无 `.github/workflows`；[`docs/LOCAL-GATE.md`](docs/LOCAL-GATE.md) 为唯一门禁说明 |
| LLM | 可选 | 草稿、诊断、能力分析；回归执行零 LLM；1M max_tokens 透传，配置/运行错误在控制台可见 |

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
| V0.4 可重复回归（已完成） | 显式批次与并行、flake 统计与看板、运行详情页、证据保留/清理、试点成功用例业务化、连续 3 批基线 | Provider 扩展、GitLab/CI、PostgreSQL、RBAC、调度 |
| V0.5-lite 需求→自动测试（已完成） | 一句话/PRD → 草稿 → 自动试跑 → 一键入回归；LLM 用量与降级可见 | 自动批准、CI、团队平台 |
| V0.6 能力探测底座（已完成） | Detect、SystemProfile、能力分类 v1、系统画像、LLM 能力分析与测试建议 | 新执行器、实时/Agent 断言 |
| V0.7 接口直连与实时机制（部分完成） | 业务接口直连、file-media、WS 帧/断言已完成 | SSE、多账号、realtime 机制包、控制台入口 |
| V0.7.5 业务接入就绪（下一阶段） | 测试数据生命周期、命名 API 环境/鉴权、cURL/OpenAPI 导入、机制接线、WS 证据入口 | 移动端、CI、多项目 |
| V0.8 Agent 机制 | 工具调用断言、幻觉/引用/多轮、LLM judge 独立 semantic suite | 自动批准、无证据 judge |
| V0.9 机制扩展与漂移 | workflow/auth-rbac/search-filter 机制包、探测 diff、pack SDK | 平台化 |
| V1.0 开源/多端 | Docker、文档、插件 SDK、Android/iOS/Harmony/Glass Adapter、基准 | 一次性完成所有端 |

V0.5 完整版（PostgreSQL、多项目、RBAC、调度器）暂缓到机制包稳定后再排；除非用户明确要求，不要提前引入团队平台基础设施。

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

## 6. V0.4 / V0.5 / V0.6–V0.9 / V1.0 摘要

| 版本 | 任务 |
|---|---|
| V0.4 | 显式批次与并行、flake 统计与看板、运行详情页、证据保留策略、试点成功用例业务化、连续 3 批基线（Provider 扩展移到 V0.5） |
| V0.5 | PostgreSQL、项目/环境模型、RBAC、调度器、趋势看板、Provider 扩展（MySQL/SQL Server/事件总线/对象存储） |
| V1.0 | Docker、插件 SDK、开放 Provider 规范、Android/iOS/Harmony/Glass Adapter、可靠性 benchmark |

### 6.1 V0.4 任务清单（可重复回归）

**执行看板**

- [x] V4-1 显式批次与并行执行 — 每条 run 独立 `run_<ts>_<rand>`、批内并发（默认 2，上限 4）；启动失败/超时也落一条 error run，不再从批次消失；批次耗时按 wall clock；重启自动恢复 running 批次；试点用例共享账号在批内串行执行，避免并发登录竞态；页面导航超时默认 45s（`TESTPILOT_NAV_TIMEOUT_MS`）；`batch-parallel` / `explicit-batch` / `batch-metrics` 测试；`pnpm verify` 全绿
- [x] V4-2 Flake 统计与看板 — flake 只统计显式批次；`repeatCount`（1–5，flake 检查 ×3，接受数值字符串）；PRODUCT_DEFECT/ASSERTION_ORACLE 均不计入 flake；按测试与全局 flake 率、failureKind 分布；`flake-metrics.test.ts`；`pnpm verify` 全绿
- [x] V4-3 运行详情页 — 控制台 run/batch 视图：步骤时间线、断言 expected/actual（API 读取时再次脱敏）、attempt/failureKind、批次链接、证据「打开/未生成」（清理后不产生死链）；`run-detail-evidence.test.ts` / `run-api-redaction.test.ts`；`pnpm verify` 全绿
- [x] V4-4 证据保留与清理 — `artifact-cleanup.ts`；**自动保留**最近 10 个 run 的 artifacts 文件夹（`TESTPILOT_ARTIFACT_KEEP_RUNS`，批次结束与服务启动时执行；实测 520MB→约 20MB）；`pnpm clean:artifacts` 默认 dry-run（`--keep-batches` / `--days` / `--max-mb`）；执行时再次校验路径必须位于 `artifacts/runs`；未知/缺值参数报错；`artifact-cleanup.test.ts`；`pnpm verify` 全绿
- [x] V4-5 试点成功用例业务化 — HTTP 断言 `statusCode/requestBodyContains` + 可选 DB 对齐清单 `docs/pilot-ticket-v04-alignment.md`；`pilot-ticket-submit-success` 与 `pilot-ticket-no-region` 已由用户人工批准（2026-11-07）；负向探针证明 HTTP 断言可失败；DB 断言在配置只读库后再追加
- [x] V4-6 连续 3 批基线 — 2026-11-07 连续 3 个显式全量批次（各 18 条）：**54/54 通过（100%）**、flake **3.7%**（2/54，均为 ENVIRONMENT 重试恢复）、单批 73–84s。此前多轮受试点环境抖动影响（登录页 30s 超时、长连接导致 run 卡 180s），已修复 runner 网络证据挂起、点击后请求竞态、试点登录/区域选择步骤；最终基线在环境恢复后取得，`pnpm verify` 全绿。后续移除冗余 `pilot-admin-login-page`（登录已被所有试点用例覆盖），当前全量 17 条；同批次 17/17 通过验证了试点串行与 45s 导航超时。
- [x] V4-7 文档与门禁 — README / `LOCAL-GATE` 并行度与清理策略；ROADMAP V0.4 看板更新；`pnpm verify` 全绿

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

## 6.2 V0.5-lite：需求 → 自动测试（测试同学可直接用）

**目标：** 测试同学贴入 PRD / 本次需求，选环境，系统生成草稿并自动试跑，给出带证据的通过/失败报告；试跑通过后一键加入回归。**自动试跑不等于自动批准**，进入回归仍由人点一次确认。

**为什么先做这个：** 现有能力已能支撑可信回归（批次、flake、证据、负向探针），但入口仍是「录制/编辑 IR → 审批 → 跑批次」。测试同学不会学 IR；要提效必须把入口收敛成一句话/一份需求。

### 执行看板

- [x] V5L-1 单页「需求 → 测试」入口 — 已合并到唯一「创建」入口（独立 `需求→测试` 菜单移除，录制作为次级入口）；`POST /api/requirement-flow` 生成草稿；demo 与试点均实跑通过。
- [x] V5L-2 Planner 生成可执行步骤 — LLM `llm-steps` 校验：testId 必须来自快照，role/name/label 允许运行时校验；拒绝 `//` 跨站、歧义选择器、密码字面量；LLM 接管时丢弃与需求无关的规则断言；正负测试覆盖。
- [x] V5L-3 草稿自动试跑与报告 — 生成后自动 trial run（trial 不计回归指标）；同页时间线/断言/证据/分型；步骤全过但断言未命中时，用运行时实际成功提示重建断言并复跑一次；试跑失败提供审阅/重生成入口。
- [x] V5L-4 一键加入回归 — 试跑通过后确认批准 + hash 校验 + 单条回归；界面显示确认跑结果并可打开详情；无自动批准。
- [x] V5L-5 环境选择与凭据引用 — demo / 试点 / 自定义白名单；试点自动前置登录步骤并使用 `baseUrlRef: pilot-admin`；凭据仍 env ref（2026-11-07 试点实跑通过）。
- [x] V5L-6 LLM 用量与失败可见 — 控制台展示累计 tokens / 调用次数 / 最近错误；用量持久化到 `data/llm-usage.json`，重启不清零；Provider 拒绝 `max_tokens` 超限时自动按错误中的上限重试并缓存；`llmTokensUsed` 不再被误脱敏（2026-11-07）。
- [x] V5L-7 文档与门禁 — README/LOCAL-GATE 写清试跑 vs 入回归边界；入口合并后文档同步；`pnpm verify` 全绿

### V0.5-lite 发布门槛

- 一条真实需求从贴入到拿到报告 ≤ 3 分钟（不含目标环境自身故障）。
- 试跑失败时能明确区分：产品缺陷、断言写错、定位失效、环境不可达。
- 通过自动试跑的用例可一键加入回归；0 条自动批准。
- LLM 不可用或超限时降级为规则草案，界面可见原因，不阻塞主流程。
- `pnpm verify` 全绿；无新增明文凭据、无弱化审批/弱断言门禁。

### 明确不做

- 自动批准、去掉 hash 校验、让 LLM 直接写回归用例。
- CI 集成、PostgreSQL、RBAC、多项目（留在 V0.5 完整版）。

## 6.3 V0.6：能力探测与机制包（下一阶段）

**目标：** 从「需求文本 → 固定模板」升级为「系统能力探测 → 机制包 → 证据断言」。不再只测增删改查；实时消息、富媒体、Agent 等系统按能力选择测试机制。

**为什么：** 现有 `planFromIntake` 是正则模板，`packages/runner-web/src/run.ts` 只开一个 browser context，`packages/evidence` 只抓 HTTP。没有 WebSocket/SSE、多账号、Agent trace，就无法证明「消息真的送达」「Agent 真的调了工具」。竞争力来自「发现系统是什么，并生成匹配的测试机制」，而不是继续堆 UI 断言。

**核心链路：**

```
URL + 账号
  → 探测会话（只读爬取 + 被动采集）
  → SystemProfile：路由/页面、表单、网络、WebSocket、SSE、上传、聊天、Agent 信号
  → 能力图谱：能力 + 置信度 + 证据 + 缺失前置条件
  → 人工确认/修正（不确定项变成问题，不猜）
  → 需求文本 + 能力图谱 → 机制路由
  → 机制包实例化：场景 + 数据 + 断言 + 负向探针
  → IR 草稿 → 自动试跑 → 人工批准 → 零 LLM 回归
```

### 6.3.1 能力分类 v1

| 能力 | 判定信号（规则优先） | 测试机制 | 证据通道 |
|---|---|---|---|
| CRUD | 表格 + 新增/编辑/删除 + 表单弹窗 | 生命周期、校验、分页、批量、幂等 | UI + HTTP + DB |
| Auth/RBAC | 登录页 + 角色/租户菜单 | 登录、会话、越权、租户隔离 | UI + HTTP |
| Workflow | 状态列 + 审批按钮 | 合法/非法流转、角色、超时 | API + DB + UI |
| Realtime messaging | WebSocket + 消息列表 + 输入框 + 发送 | 双人送达、图片、超长、重连、顺序/去重 | WS frame + API + DOM(+DB) |
| File/media | `input[type=file]` + accept | 类型、大小、损坏、预览、下载 | 上传 API + 元数据 + DOM |
| Search/filter | 搜索框 + 分页 + 排序 | 语义、空态、组合条件、注入 | API + DOM |
| Agent | 聊天 + 流式 + 工具块 + 模型/引用 | 工具调用、禁用工具、幻觉、引用落地、多轮、预算 | OTel trace + API + LLM judge |
| Rich content | contenteditable + mention/reaction | 富文本、粘贴、提及、表情 | DOM + API |

CRUD 不是被抛弃，而是变成机制包之一；现有规则模板就是它的 v0。

### 6.3.2 机制包契约

机制包是**代码里评审过、有测试的模块**，不是 LLM 现场生成：

```ts
interface MechanismPack {
  id: string;
  capability: CapabilityId;
  requires: Requirement[];         // second-actor / ws-observable / trace-source / upload-fixture
  scenarios: ScenarioTemplate[];   // 参数化，产出 IR
  assertions: AssertionTemplate[]; // 从探测证据绑定，不猜
  negativeProbes: ProbeSpec[];     // 机制坏了必须能让断言失败
  safety: { mutation: "none" | "sandbox-only" | "allowed"; maxActions: number };
}
```

- 场景是模板：选择器来自探测快照，数据生成器负责 run marker、长文本、图片、Unicode，产物仍是现有 IR。
- 缺少前置条件（第二账号、trace 源、WS 可观测）时，控制台显示「已探测到但当前不可测」，不降级成假测试。
- 每个新断言类型必须先有负向探针（阻断 WS 投递、返回 500、删掉工具调用、喂幻觉答案），否则不允许启用。
- 超长消息不猜产品上限：先断言「不崩溃、不静默丢、明确错误或完整送达」的不变量，人工确认后再钉成契约。

### 6.3.3 LLM 使用边界

| 环节 | 规则引擎 | LLM |
|---|---|---|
| 探测 | 采集、信号、打分、证据关联、schema/证据校验、缓存 | 读有界证据做能力归类（含规则未覆盖的新能力）、子能力、测试建议与待确认问题 |
| 规划 | 选机制包、实例化场景、生成数据、构造断言 | 界面语义绑定、边界场景候选 |
| 校验 | schema、元素绑定、证据引用、负向探针 | 无 |
| 运行 | 确定性断言零 LLM | 仅 `semantic suite` |
| 诊断 | 失败分型、重试策略 | 失败解释、修复建议 |

四个硬约束：

1. LLM 输出必须是 JSON schema；优先落在固定能力枚举里，只有带证据时才能提出新的自定义能力 slug（如 `agent-mcp`），并作为补充能力展示，不覆盖规则结论。
2. 每条结论必须引用证据（route / 可见标签 / 控件 / API 路径），无证据的结论直接丢弃。
3. 按证据 hash 缓存，检测一次复用；每次会话有 token 预算，超了降级为规则 + 人工问题。
4. LLM 不写回归用例，只做「候选/补全」，必须过规则校验和人工审批。

**回归零 LLM 的红线保留：** CRUD、实时、媒体、工作流继续零 LLM。Agent 的语义判断单独成 `semantic suite`，有独立预算和门禁；或者先用 LLM 在编写期校准 deterministic proxy，回归只跑 proxy。

### 6.3.4 执行看板

**V0.6 探测底座（约 2 周）**

- [ ] V6-1 `SystemProfile` + `packages/detect` — 定义路由/页面/表单/网络/WS/SSE/上传/聊天/Agent 信号的数据结构与版本；`pnpm verify` 全绿
- [x] V6-2 被动采集器 + 有界爬取 — `packages/detect/src/collector.ts` + `signals.ts`；登录后枚举同源路由（上限 12），只读不提交；采集 DOM/表单/网络/WS/SSE；隐式 submit/cancel 与 destructive 名称有安全回归；`collector.test.ts` / `signals.test.ts`；`pnpm verify` 全绿（2026-11-08）
- [x] V6-3 能力分类规则 v1 — `packages/detect/src/rules.ts` 覆盖 CRUD/Realtime/Auth/Workflow/File-media/Search-filter/Agent/Rich content；每类正例 + 部分信号提问；`rules.test.ts` 表驱动；`pnpm verify` 全绿（2026-11-08）
- [x] V6-4 LLM 能力分析 — `services/test-management/src/llm-detect.ts`：有界脱敏 digest（页面/iframe/接口/规则结论）→ 能力、子能力、测试建议、待确认问题；schema 校验、无证据丢弃、置信度钳制、token/输出/超时预算、按 digest hash 缓存；规则能力标 `hybrid`，规则未覆盖的能力进 `llmCapabilities`；真实画像不落页面文本；`llm-detect.test.ts` + 探测并行测试；真实环境一次调用发现小智 Agent / 工具市场 / MCP / 技能 / 记忆 / 设备控制（12,003 tokens）（2026-11-08）
- [x] V6-5 系统画像与 API — `services/test-management/src/detection.ts` + `/api/detect` jobs/profiles；复用 session 目录 `kind: "detect"` 与 20 个会话保留；控制台「系统画像」页与创建页能力提示；`detection.test.ts`；demo 实测 CRUD/文件/媒体，`pnpm verify` 全绿（2026-11-08）
- [x] V6-6 demo/试点/真实环境验证 — demo 识别 CRUD 0.86 / 文件 0.90 / 搜索 0.72；试点识别文件 0.90 / 工作流 0.65；真实环境识别文件 0.90 / CRUD 0.82 / 搜索 0.72 / 实时消息 0.66（均含 LLM 测试建议），并补充 8 项 LLM 能力：小智 Agent、工具市场、MCP、技能、记忆/知识图谱、设备控制、认证、SOP；页面文本/标题/人名不落盘；`pnpm detect:validate -- --target all|real` + `artifacts/detect/validate-last.json`；`pnpm verify` 全绿（2026-11-08）

**V0.7 接口直连、文件媒体与 WS 管道（已完成部分）**

**第一目标：业务接口直连（V7-0，先做）**

现有 `api` 断言只能匹配页面操作触发的真实请求，无法主动调用业务接口。先把「接口测试」变成一等能力，再做 UI/机制包。

- [x] V7-0a `request` 步骤 — `StepAction` 增加 `request`；IR schema/types/validator 支持 `method`/`path`/`headers`/`body`/`form`/`saveAs`/`saveFields`；runner 用 `browserContext.request` 执行，自动复用已登录浏览器的 Cookie；仅允许同源，禁止任意 URL / SSRF（`maxRedirects: 0`）；schema 正反例 + demo `POST /api/users` 正例 + Cookie 复用 + 跨源/缺字段/跨源重定向负例（`request-step.test.ts`）（2026-11-08）
- [x] V7-0b 变量与模板 — `{{runId}}`、`{{var}}`、`{{env.KEY}}` 在 path/headers/body/form 中解析（`env.KEY` → `TESTPILOT_ENV_*`，IR 只存 key 名）；`saveAs` + `saveFields` 点路径提取变量；缺变量/缺 env 步骤失败；解析后的 env 值不进步骤错误和证据文件（`request-template.test.ts`、`request-step.test.ts`）（2026-11-08）
- [x] V7-0c 请求证据接入 — `recordNetworkEntry` 写入现有 network 日志并参与 `waitForNetworkEntry`；`captured-http` 的 `requestRef` 可断言 `request` 步骤（201 + JSON）；Authorization/Cookie/Set-Cookie 脱敏，请求体/响应体沿用 8000/4000 截断；`network.json` 可下载（`direct-request.test.ts`、`request-step.test.ts`）（2026-11-08）
- [x] V7-0c2 断言按步骤绑定 — `TestAssertion.stepRef` 直接匹配 `request` 步骤（证据带 `stepId`），业务接口用例无需在代码或环境里维护 requestRef 映射；`requestRef` 与 `stepRef` 二选一，`stepRef` 必须指向已有 request 步骤；schema + 语义校验 + 正负测试（2026-11-09）
- [x] V7-0d demo 验证 — demo API-only 用例：登录页 → `POST /api/users`，断言 201 + email、409 重复邮箱、400 缺邮箱（`api-user-create.json`、`api-duplicate-email.json`、`api-missing-email.json`）；`requestRef` 由 `env.requestRefs` 映射到 url/method；故障注入返回 500 或错误 JSON 时原断言以 `PRODUCT_DEFECT` 失败（`api-direct-demo.test.ts`）；`pnpm verify` 全绿（2026-11-09）。试点/真实接口未验证，等 V7-0e 明确授权后再接
- [x] V7-0e 控制台接口用例 — 创建页新增「接口测试」模式：方法/路径/请求头/请求体、状态码/响应文本/响应 JSON 断言、环境选择与自定义 URL；提交后自动保存为**草稿**并试跑，不自动批准；审阅面板识别 `sourceChannel: "api"`，不再注入整页 UI 断言，步骤编辑器可查看/编辑 `request` 步骤；试点/真实环境在界面层拒绝，需后续明确授权；`api-test-draft.test.ts` + `api-test-route.test.ts` + 浏览器实跑（2026-11-09）

**V0.7.5 业务接入就绪（下一阶段，P0，按顺序做）**

目标：测试人员能在明确授权的环境里，对一个业务系统跑通「创建 → 断言 → 清理」，不留下脏数据。

- [x] V7-7 测试数据生命周期（2026-11-11）— IR：`policy.cleanup: "none" | "on-success" | "always"` + `teardownSteps`，进入 schema/语义校验/IR hash，teardown id 不得与主步骤重复；runner：主步骤/断言失败后仍执行 teardown，`RunResult.cleanup` 记录状态/步骤/错误，主流程通过而清理失败标 `TEST_DATA`，主流程已失败时保留 `PRODUCT_DEFECT`；控制台：审阅显示清理策略与 teardown、运行详情显示清理结果、接口模式可填清理请求并复用主请求头/自动保存 `{{createdId}}`、写接口缺少 `{{runId}}` 警告；demo `/api/items` + `api-items-cleanup.json` 加入 smoke/种子；`cleanup.test.ts` 覆盖通过、断言失败、步骤失败、清理 500、`none`、`on-success`；浏览器实测创建条目→试跑→清理通过→`GET /api/items` 为空；`pnpm verify` 全绿
- [x] V7-0f 命名 API 环境与鉴权头（2026-11-11）— `docs/api-envs.example.json` + gitignore `api-envs.json` + `TESTPILOT_API_ENVS_FILE`；`GET /api/api-envs` 仅返回 headerNames；`POST /api/api-tests` 支持 `envId`、头合并、`allowWrite` 写方法门禁（含 cleanup）；控制台环境选择与只读方法限制；`api-envs.test.ts` + 扩展 `api-test-route.test.ts`；Playwright 浏览器抽检；`pnpm verify` 全绿
- [x] V7-0h cURL 导入（2026-11-11）— `packages/test-ir/src/curl-import.ts` + subpath export；shell 风格 tokenizer；丢弃鉴权头/`-u`/`--oauth2-bearer`；`curl-import.test.ts` 正反例 + 安全断言；控制台 `ApiTestView` 折叠导入区 + 环境/只读方法联动；`pnpm --filter @testpilot/test-ir test` / `build`、`pnpm --filter @testpilot/console typecheck`、`pnpm verify` 全绿；Playwright 抽检见 §0.1 执行顺序项 2
- [ ] V7-5e 机制接线 — `GET /api/detect/:id/mechanisms` 返回机制计划（先 file-media）与 blockers；`POST /api/mechanisms/file-media/draft` 生成草稿（可选试跑）；控制台系统画像显示「可测机制 / 缺什么」，不再只给能力百分比
- [ ] V7-6b WS 证据入口 — 运行详情可打开 `ws.json`，显示收发帧摘要、方向、截断/丢弃数量；仍按现有脱敏规则
- [ ] V7-0i OpenAPI 导入 — OpenAPI 3.x（JSON/YAML）选择 operation → 预填接口用例；只在本地解析，不上传外部；生成草稿，不自动批准
- [x] V7-9a 步骤截图时间线与失败回放（借鉴 Midscene，2026-11-12）— `policy.screenshots: "always"` 下每步落图并记入 `StepResult.screenshot`/manifest；控制台时间线缩略图、点击看原图、「跳到失败步骤」；`on-failure`/`never` 不变；三种策略测试 + 浏览器实测

**P1 backlog（V0.7.5 之后）**

- [ ] V7-0g 接口用例编辑 — 用例列表对 `sourceChannel: "api"` 提供「编辑接口」，表单回填并保存为新版本，而不是只能改 JSON
- [ ] V7-1b SSE 证据 — 采集 SSE chunks；与 WS 共用脱敏/截断；证据可下载
- [ ] V7-2 多账号执行 — IR 增加 `actors`，runner 支持多 browser context、`waitForEvent`；单账号回退必须显式标注
- [ ] V7-4 realtime-messaging 机制包 — 文本送达（出站 WS + 入站 WS + 对方 DOM）、图片、超长、重连、顺序、去重
- [ ] V7-9b 生成期视觉定位建议（借鉴 Midscene）— 截图 + 裁剪 ARIA → 1–3 个 locator 候选与包围盒；人工选定后写入 IR；运行时零模型调用；建议缓存只读；试点/真实默认关闭

**第二批：文件/媒体（接口直连验收后）**

- [x] V7-5a `upload` 步骤 — `StepAction` 增加 `upload`；IR schema/types/validator 支持；runner 用 Playwright `setInputFiles`，文件路径只从 `valueRef` → env 解析，限制在 `TESTPILOT_FIXTURE_DIR` 内；越界/缺失/目录路径必须有负向测试（`upload-path.test.ts`、`upload-step.test.ts`：正常上传通过；缺 env、目录、`..`/绝对路径、符号链接逃逸失败且不读文件；2026-11-09）
- [x] V7-5b demo `/files` — `examples/demo-webapp/files.html` + multipart `POST /api/files`、`GET /api/files`、`GET /api/files/:id/content`、`DELETE /api/files/:id`；只收 image/png、image/jpeg、application/pdf，大小上限 1 MB（413/415）；内存存储，不落盘；故障注入开关（拒绝合法上传 / 接受非法类型）用于负向探针（`files.test.mjs`：201/列表/下载/删除、413、415、坏 multipart、两种故障注入；`pnpm --filter @testpilot/demo-webapp test`；2026-11-09）
- [x] V7-5c `packages/mechanisms` + file-media pack — `planFileMedia(profile, ctx)`：file-media 能力缺失时返回 `runnable: false` + 原因；否则生成可评审 IR（navigate → upload → 提交），断言上传请求 201 + 响应 JSON + 列表出现文件名；支持类型/大小负例场景（`file-media.test.ts`：无能力/低置信度不生成 IR；happy 通过 validateTestIR + validateAssertionProviders；IR 无绝对路径或密钥；缺可选 fixture 时跳过并说明；2026-11-09）
- [x] V7-5d 负向验证 — 故障注入「拒绝合法上传」时正向机制必须失败；「接受非法类型」时负例必须失败；`pnpm verify` 全绿（`file-media-demo.test.ts`：正常上传通过；`DEMO_FILES_REJECT_VALID=1` 时 happy 为 PRODUCT_DEFECT；`DEMO_FILES_ACCEPT_INVALID=1` 时 invalid-type 为 PRODUCT_DEFECT；`pnpm verify` 2026-11-09 通过）

**第三批：实时消息（文件/媒体验收后）**

**第一波：WS 管道（先做，单页面即可验证）**

- [x] V7-1a WS 帧证据 — 用 Playwright `page.on("websocket")` 采集 framesent/framereceived：方向、URL、大小、前 N 条 payload；单条截断、总数上限；`ws.json` 可下载；Authorization/Cookie 等敏感内容按现有规则脱敏（`ws-frames.test.ts`：收发方向、4500 截断到 4000、超过 200 帧丢弃并写入 note、token/email/password 不落盘；`network.json` 仍是数组；2026-11-10）
- [x] V7-3a `ws` 断言 Provider — `type: "event"` + `provider: "ws"`；expect 支持 `urlIncludes`、`direction`、`contains`、`regex`、`jsonPath` + `equals`、`minCount`、`absent`、`timeoutMs`（`ws.test.ts`：同一帧命中/不命中、direction、regex、jsonPath、minCount、absent、超时为 PRODUCT_DEFECT、非法 expect 为 ASSERTION_ORACLE；阻断广播的负向探针在 V7-6a；2026-11-10）
- [x] V7-6a demo `/chat` + 集成验证 — `examples/demo-webapp` 加 `/chat`（消息列表/输入框/发送按钮）与 `/ws/chat` 广播；`DEMO_CHAT_DROP=1` 与 `?drop=1` 只丢弃广播；runner 集成：发送 → 出站帧 + 入站帧 + 页面文案；drop 时 received 为 PRODUCT_DEFECT；`pnpm negative-probes` 5 个 provider；`pnpm verify` 全绿（2026-11-10）

**第二波：多账号与 realtime 机制包（V0.7.5 之后）**

任务见上方 P1 backlog（V7-1b / V7-2 / V7-4），另加：

- [ ] V7-6c 控制台 — 选择机制包、查看 WS 证据；`pnpm verify` 全绿

**V0.8 Agent 机制（约 2～3 周）**

- [ ] V8-1 Agent 面探测 — 聊天 + 流式 + 工具块 + 模型/引用 + agent 接口信号；识别 `trace-source` 前置条件
- [ ] V8-2 Agent 断言增强 — 工具名/参数/次数/顺序/禁用工具/耗时/token；缺 trace 时明确「不可测」
- [ ] V8-3 `llm-judge` Provider — rubric + evidence + threshold + budget + 负向探针；oracle 必须人工批准
- [ ] V8-4 agent 机制包 — 必须调工具、不该调工具、禁止工具、引用落地、多轮、未知/拒答、预算
- [ ] V8-5 demo `/agent` + semantic suite — mock 工具调用 + trace fixture；semantic suite 与零 LLM 回归分开计费/门禁；`pnpm verify` 全绿

**V0.9 机制扩展与漂移（约 2 周）**

- [ ] V9-1 workflow 机制包 — 合法/非法流转、角色、超时
- [ ] V9-2 auth/rbac 机制包 — 登录、会话、越权、租户隔离
- [ ] V9-3 search/filter 机制包 — 语义、空态、组合条件、注入
- [ ] V9-4 探测重跑与 diff — 路由/能力/选择器变化时提示受影响用例，不自动改批准
- [ ] V9-5 pack SDK + 文档 — 新能力以插件方式接入；`pnpm verify` 全绿

### 6.3.5 发布门槛与验收指标

- V0.6：demo 识别 CRUD/上传/搜索；试点识别当前工单面；真实环境识别 IM/文件并发现 Agent 平台；每次探测 1 次 LLM 分析（digest 命中缓存时 0 次），所有 LLM 结论必须带证据；误判以问题呈现；0 条自动批准。
- V0.7：业务接口可主动调用（同源、复用登录 Cookie）并断言状态/JSON/头，返回 500 或错误 JSON 时断言必须失败；文件上传可被断言且故障注入时失败；单页面 WS 收发帧可断言，阻断广播时断言必须失败。多账号 A→B 归入 P1。
- V0.7.5：写业务数据的用例，通过和失败都要执行 teardown；清理失败可见且不掩盖产品缺陷；试点/真实没有 `allowWrite` 时只能只读；cURL/OpenAPI 生成的接口草稿必须人工批准；控制台能看到「可测机制 / 缺少的前置条件」。
- V0.8：工具调用可确定性断言；喂一个「编造答案」的 agent 时幻觉用例必须失败；LLM judge 无证据不得通过；成本可见。
- V0.9：4 个以上机制包；探测 diff 能指出受影响的用例；不自动改批准。

| 指标 | 目标 | 测量方式 |
|---|---|---|
| 能力识别 precision/recall | 标注 fixture 上 ≥90% | 探测报告 vs 人工标注 |
| 需求 → 机制路由准确率 | ≥90% | 固定需求集回放 |
| 新断言类型负向探针 | 100% | `pnpm negative-probes` |
| 每次探测 LLM 调用 | ≤1 次（缓存命中 0 次） | `data/llm-usage.json` / 探测报告 |
| 假绿事故 | 0 | 评审 + 负向探针 |
| 回归 flake | <5% | flake 统计 |

### 6.3.6 明确不做

- 不让 LLM 自由生成整套回归用例。
- 不把无证据的 LLM judge 作为唯一通过条件。
- 探测默认只读；写操作只在 demo、测试账号或显式允许的沙箱。
- 没有第二账号或 trace 源时，不假装测过，明确标「当前不可测」。
- 不自动批准、不弱化审批/弱断言门禁、不改安全默认值、不引入 CI/PostgreSQL/RBAC/Docker，除非用户明确要求。

### 6.3.7 建议的第一个垂直切片

不要直接接真实业务系统。先在 `examples/demo-webapp` 加 `/chat`（WS 双人）、`/agent`（mock 工具调用 + trace）、`/files`，然后：

1. Detect 跑通，输出能力图谱。
2. realtime pack 跑通文本/图片/超长 + 负向探针。
3. agent pack 跑通工具调用 + 幻觉负向。
4. 再接真实试点环境，校准真实选择器、账号和前置条件。

能力分类与机制包必须保持产品无关；真实环境只用于校准，不作为机制本身的一部分。

理由：实时和 Agent 测试没有可控 fixture，就无法证明断言能失败，也无法在 `pnpm verify` 里稳定回归。

## 7. Cursor 工作协议

- 一次只做一个垂直切片；任务来自本路线图的 ID，不自行扩大范围。V0.4 起允许同一会话连续完成多个任务，但每个任务必须单独 commit、单独验证。
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
- 能力探测已可用，但需求生成仍走 `planFromIntake` 规则模板；把 `SystemProfile` 用于机制路由在 V0.7/V0.8。
- 无 WebSocket/SSE 帧证据、无多 browser context/多账号执行；实时消息与富媒体机制尚未接入（V0.7）。
- Agent 断言目前只读 OTel trace；无幻觉 rubric、无独立 semantic suite（V0.8）。
- 真实环境只开放系统画像；创建/试跑未开放，避免自动写入业务数据。聊天页当前无会话，V0.7 需要人工准备测试会话后再验证消息投递。
- SPA 视图已采集信号，但 `SystemProfile.surfaces` 目前只记录 URL 路由；V6-5 控制台需要按视图展示时再补。
- 无 PostgreSQL 持久化 / 多项目 / RBAC / 远程 CI（V0.5 完整版暂缓）。

### 11.4 证据要求

每个 P0 任务完成时，必须附：

- 变更文件列表。
- `pnpm verify` 输出。
- 正向与负向运行结果。
- Trace/network/DB/agent 证据路径。
- 未验证项与风险。

---

**一句话：v0.3 不追求更多页面和更多按钮，追求「每条通过的测试都能证明业务真的发生了」。**

**一句话：v0.6 不追求更多断言类型，追求「先发现系统是什么能力，再用该能力的真实证据去证明它」。**

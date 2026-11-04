# ADR-006: 可扩展断言引擎（Assertion Engine v2）

**Status:** Accepted（2026-11-04 评审决定）
**Related:** Roadmap v0.3 · `packages/assertions` · `packages/test-ir` · `services/test-management`

## Context

当前 `packages/assertions` 用 switch 写死 `ui` / `api` 两类，`db` / `event` 直接返回未实现。业务真相通常不在页面文案里：

- 工单是否真的写入数据库。
- 智能体是否调用了指定工具、参数是否正确、是否调用了禁止工具。
- 消息是否发出、对象存储是否生成文件。
- API 响应体是否符合契约。

继续在 runner 里堆 if/else 会让每种新断言都改执行器，无法配置、无法复用、无法做负向验证。

## Decision

引入 **Provider 注册表**：IR 描述「断言什么」，Provider 负责「怎么查、怎么判、怎么取证」。

### 1. IR 扩展（向后兼容）

```ts
type AssertionKind = "ui" | "http" | "db" | "agent" | "event" | "custom";

interface TestAssertion {
  id?: string;
  type: AssertionKind;
  provider?: string;          // 注册表 id，例如 postgres-readonly
  configRef?: string;         // 项目/环境配置引用
  target?: Locator;           // ui 兼容字段
  contains?: string;          // ui 兼容字段
  requestRef?: string;        // http 兼容字段
  expect?: Record<string, unknown>; // provider 自己的 schema
  oracle: OracleSource;
}
```

旧 IR 不带 `provider` / `configRef` 时使用内置默认 Provider：`ui` → `playwright-ui`，`api` → `captured-http`。新增字段不破坏旧用例。

### 2. Provider 契约

```ts
interface AssertionProvider {
  id: string;
  kind: AssertionKind;
  validate(assertion: TestAssertion): ValidationIssue[];
  run(assertion: TestAssertion, ctx: AssertionContext): Promise<AssertionOutcome>;
  evidence?(outcome: AssertionOutcome): ArtifactRef[];
}

interface AssertionContext {
  runId: string;
  page?: Page;
  network?: CapturedNetworkEntry[];
  env: RunEnvironment;
  db?: DbClient;        // 按 configRef 解析
  traces?: TraceClient; // 按 configRef 解析
  http?: HttpCapture;
}
```

注册表只暴露给执行器与审批校验；Provider 不直接读取 `process.env`，所有连接/密钥由 `configRef` 解析后注入。

### 3. 内置 Provider

**playwright-ui**
- 支持 target、可见性、数量、属性、URL、稳定文案。
- 整页 `contains` 仍然受弱断言门禁限制；默认要求 target 或足够具体的文案。

**captured-http**
- 基于本次运行捕获的网络，不额外发请求。
- 支持状态码、响应体、JSON Schema、响应头、请求体、requestRef。

**postgres-readonly（首个 DB Provider）**
- 只读连接；连接串来自 `configRef` 的 env ref。
- IR 只引用命名查询 `queryRef`；SQL 存放在配置中，参数化。
- 支持 `rowCount`、`row` 部分匹配、字段值、存在/不存在、按 runId 关联。
- 表和字段白名单；禁止 IR/LLM 生成任意 SQL。
- 证据：脱敏后的查询结果快照 + 查询名称 + 行数。

**otel-trace（首个 Agent Provider）**
- 从 OTel/JSON trace 导入；按 `traceRef`（通常是 runId）关联。
- 支持工具调用名称、参数部分匹配、最小/最大次数、顺序、禁止工具、耗时/token。
- 证据：traceId、命中的 span、工具调用摘要；参数可脱敏。

**event / custom**
- 后续按同一契约扩展；custom Provider 通过 SDK 注册。

### 4. 配置与审批

配置存放在项目/环境级（不进 IR）：

```json
{
  "db": {
    "postgres-readonly": {
      "connectionRef": "env.PILOT_DB_URL",
      "queries": {
        "order-by-run-id": "SELECT id, status FROM work_order WHERE ref = :runId"
      },
      "allowedTables": ["work_order"]
    }
  },
  "agent": {
    "otel-trace": {
      "endpointRef": "env.OTEL_QUERY_URL",
      "service": "pilot-agent"
    }
  }
}
```

- 配置有 `version` / `hash`。
- 审批记录：IR hash + 配置版本 + 审批人。
- 配置变更导致已批准用例语义变化时，应要求重新审阅（至少警告并记录）。
- 密钥只通过 `env.*` 引用解析，不进入 IR、日志、LLM prompt。

### 5. 负向验证

每个 Provider 必须提供可复现的「预期失败」测试：

| Provider | 负向场景 |
|---|---|
| playwright-ui | 删除目标元素/文案 → 失败 |
| captured-http | 返回 500 或错误响应体 → 失败 |
| postgres-readonly | 查询 0 行或字段不符 → 失败 |
| otel-trace | trace 缺少指定工具调用 / 出现禁止工具 → 失败 |

没有负向验证的断言不得进入「已批准」。

### 6. 迁移与兼容

- IR schema 版本仍为 v1，新增可选字段；旧用例默认 Provider 行为不变。
- 现有 `ui`/`api` 断言继续工作。
- `db`/`event` 从未实现变为需要显式 `provider` + `configRef`；未配置时批准阶段直接报错，不静默通过。

## Alternatives considered

- **继续 switch 扩展**：改动集中在 runner，无法配置/复用/独立测试；拒绝。
- **IR 里写 SQL**：灵活但不可审计，存在注入与越权风险；拒绝。
- **LLM 生成查询/工具断言**：不可复现、可能泄露数据；仅允许生成建议，人工批准后落为命名查询/显式 expect。
- **只做 HTTP/DB**：无法覆盖 agent/工具/事件；拒绝。

## Consequences

- 配置面变大：需要配置 UI、连接测试、版本/hash、审计。
- 需要 Provider SDK 文档与模板，否则扩展仍靠改核心。
- 证据量增加：DB/agent 证据需要脱敏与保留策略。
- 测试与负向验证成为批准门槛，短期会降低「已批准用例数」，但提升可信度。
- 执行器上下文需要按需注入，避免 Provider 拿到不需要的权限。

## Implementation plan

1. 在 `packages/assertions` 引入注册表与 `AssertionProvider` 类型；`runAssertion` 改为查表。
2. `test-ir` schema 增加 `provider`、`configRef`；批准时校验 Provider 是否存在。
3. 实现 `captured-http`（从现有 api 断言迁移）。
4. 实现 `postgres-readonly` + 配置解析 + 证据快照。
5. 实现 `otel-trace` + trace 导入 + 工具调用断言。
6. Console 增加类型/Provider/expect 配置与测试连接。
7. 每个 Provider 补正负测试；接入 `pnpm verify`。
8. 文档：Provider SDK、配置示例、负向验证指南。

## Open questions

- DB 查询结果如何做字段级脱敏与保留期？
- Agent trace 的稳定来源：OTel collector、JSON 文件，还是项目 API？
- 配置版本变化是否强制重置审批，还是只警告？
- 是否允许项目级自定义 Provider（需要沙箱/权限模型）？

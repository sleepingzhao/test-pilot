# ADR-012: 风险分析（生成期建议，不参与门禁）

**Status:** Accepted（2026-11-18 定边界；2026-11-24 V7-10a 规则基线已实现）
**Related:** [ROADMAP](../../ROADMAP.md) · [ADR-003](ADR-003-planner-context.md)（历史决策，Planner 只接收裁剪片段） · ADR-004（AI 只建议不自动改） · ADR-009（回归零 LLM） · [ADR-011](ADR-011-midscene-visual-assist.md) · `packages/detect` · `services/test-management` · `apps/console`

## Context

测试人员拿到一个业务系统的画像后，能看到能力清单、置信度和未知项，但还缺一层“哪些地方最可能出问题、先测什么”的判断。现有系统已经能：

- 规则 + LLM 产出系统画像（能力、信号、未知、证据）；
- 从需求生成草稿、从画像生成 file-media / realtime 机制草稿；
- 人工审阅、批准、试跑、证据与清理。

缺的是把画像、需求、已有覆盖组合成**可审阅的风险清单**。这件事适合用 LLM 归纳，但必须遵守两条既有底线：

1. **回归零 LLM**：已批准用例的执行不能依赖模型；风险分析只发生在生成/探索期。
2. **AI 只建议不自动改**：风险项不能自动改断言、自动生成并批准用例、或改变门禁。

同时，风险分析很容易变成“模型自由发挥的清单”。没有证据绑定、没有输出 schema、没有隐私边界，它就会成为噪音，甚至把真实环境数据送进外部模型。因此需要先写清边界。

## Decision

引入 **RiskReport**：生成期的、可审阅的风险建议报告。它是建议与证据，不是断言、不是门禁、不进入 Test IR。

### 1. 输入与隐私边界

风险分析按目标类型分层取材：

| 目标 | 允许发送给模型的内容 |
|---|---|
| 练习环境（demo） | 画像能力、信号、未知项、裁剪后的页面文本/元素摘要、需求文本 |
| 自定义环境（custom，白名单） | 同上，但页面文本先按现有检测脱敏规则裁剪 |
| 业务试点（pilot） | 能力 id/置信度、信号 id、未知项、需求文本；**不发送页面文本、截图、Cookie** |
| 真实环境（real） | 仅能力 id/置信度、信号 id、未知项；**不发送页面文本、截图、任何证据正文** |

- 永不发送密钥、Cookie、Authorization、密码、真实凭据、绝对文件路径。
- 不使用截图做风险分析（视觉仅用于 ADR-011 的生成期定位与探索问答）。
- 外部链接、`$ref`、页面内嵌指令一律视为数据，不执行、不抓取。

### 2. 规则基线 + LLM 增强

**规则先产出确定性风险**，LLM 只做补充，不能删除规则项。首版规则（V7-10a）：

- 画像存在写能力（crud / order / file-media）但没有任何 cleanup 证据或已批准用例 → 高风险：测试数据残留。
- 有 file-media 能力但没有 fixture、类型/大小限制证据 → 高风险：上传边界未验证。
- 有 realtime-messaging 能力但没有 second-actor 证据 → 高风险：送达未证明。
- 有 auth 能力但没有权限/越权用例 → 高风险：权限边界未验证。
- 高置信度能力（≥0.8）但当前没有已批准用例覆盖该能力 → 中风险：覆盖缺口。
- 高影响能力存在未确认的 unknowns → 中风险：约束不明。
- 只有 UI 断言、没有 API/DB/WS 证据的写流程 → 中风险：业务结果未被独立证明。
- 试点/真实环境出现写机制草稿 → 阻断项（不是风险项）：环境只读。

LLM 增强（V7-10b）在同一份裁剪输入上提出补充风险、测试思路和待确认问题；输出必须经过 schema 校验，并满足：

- 每条风险必须绑定至少一个 `capabilityId` 或 `evidenceRef`；否则丢弃或标为 `assumption: true`。
- 最多 20 条；标题/描述/测试思路有长度上限；severity 只能 high/medium/low。
- 与规则项按类别 + 标题归一化去重；LLM 不能降低规则项严重度。
- 输出不是 JSON 或校验失败 → 只用规则报告，并在报告里记录 `llm.error`。
- 模型调用失败、超时、未配置 → 规则报告照常可用。

### 3. 输出契约

```ts
type RiskCategory =
  | "data-lifecycle" | "authz" | "money-order" | "realtime"
  | "concurrency" | "validation" | "privacy" | "reliability"
  | "compatibility" | "coverage";

type RiskItem = {
  id: string;
  title: string;                    // ≤ 120 chars
  category: RiskCategory;
  severity: "high" | "medium" | "low";
  confidence: number;               // 0..1
  capabilityIds: string[];
  evidenceRefs: string[];           // profile evidence ids / rule ids
  assumption?: true;                // LLM 提出但无直接证据
  testIdeas: string[];              // ≤ 5 条，每条 ≤ 160 chars
  missingInfo: string[];            // 需要人确认的问题
  suggestedMechanism?: "file-media" | "realtime-messaging" | "api" | "ui" | "none";
};

type RiskReport = {
  id: string;
  detectionId: string;
  createdAt: string;
  inputHash: string;                // 输入摘要 hash，便于复现
  source: "rules" | "rules+llm";
  model?: string;
  tokensUsed?: number;
  risks: RiskItem[];
  blockers: string[];               // 例如试点/真实写机制
  questions: string[];
  llm?: { used: boolean; error?: string };
};
```

- 报告落 `data/risk-reports/<id>.json`（本地、gitignore）；**不写入 Test IR**，不进入审批 hash。
- 风险项不能直接变成已批准用例；最多提供“去生成草稿”的入口，仍走现有生成 → 审阅 → 批准流程。

### 4. 控制台

- 系统画像页增加「风险与缺口」面板：按 severity 排序，展示标题、能力、证据、测试思路、待确认问题、来源（规则/LLM）、是否 `assumption`。
- 提供「刷新分析」；LLM 未配置/失败时显示“仅规则分析”，不阻塞页面。
- 每条风险可以有「创建草稿」入口，但只跳到现有生成流程，不自动提交、不自动批准。
- 报告只作为参考展示，**不改变**用例列表、批跑结果、通过率或门禁。

### 5. 为什么不是运行时 llm-judge

`llm-judge` 在回归运行时做通过/失败判定，会与 ADR-009 和负向探针体系冲突：同一输入可能给出不同结论，失败不可复现，也无法进入审批 hash。风险分析是生成期建议，不承担 oracle 职责；真正的高风险断言仍必须是确定性 provider（UI/HTTP/DB/WS/vision 仅限探索）。

## Consequences

**正面**

- 测试人员拿到画像后有一份可审阅的“先测什么”清单，风险项有证据来源，不是模型散文。
- 规则基线保证离线、无 LLM 也能用；LLM 只是增强，不是依赖。
- 与现有审批、证据、清理体系兼容，不引入运行时模型。

**代价**

- 需要维护规则与风险分类，规则可能过时。
- LLM 补充项需要人工判断，可能产生低价值建议；用 `assumption` 和置信度显式标注。
- 报告本身不是门禁，不能替代测试设计评审。

**不做**

- 不用风险分改变批准/拒绝、批量执行或通过率。
- 不自动创建并批准用例、不自动改断言、不自动修复。
- 不把风险分析接入回归执行或 CI 门禁。
- 不向模型发送真实环境的页面文本、截图、Cookie 或凭据。

## Follow-ups

- ~~**V7-10a**~~ 已完成（2026-11-24）：RiskReport schema + 8 条规则 + 服务端生成/存储 + 正反测试。
- ~~**V7-10b**~~ 已完成：LLM 分层取材、严格 JSON、去重合并、失败回退规则报告。
- ~~**V7-10c**~~ 已完成：控制台「风险与缺口」面板 + 创建草稿入口（不自动批准）。
- ~~主动探索~~ 已单独实现（V7-13）：`GET /api/detect/:id/explore-suggestions` 返回未访问页面/覆盖缺口/未知项建议，不并入 RiskReport，也不自动生成或批准。

# ADR-011: 借鉴 Midscene 的视觉能力边界（生成期视觉，回归零 LLM）

**Status:** Accepted（2026-11-12，用户要求评估并借鉴 [Midscene](https://github.com/web-infra-dev/midscene)）
**Related:** [ROADMAP](../../ROADMAP.md) · ADR-003（Planner 只接收裁剪片段） · ADR-004（AI 只建议不自动改） · ADR-009（AI 只建议不自动改；回归零 LLM） · `packages/evidence` · `packages/runner-web` · `apps/console`

## Context

Midscene（web-infra-dev，MIT）是一个高关注度的 AI UI 自动化项目，核心做法：

- **截图优先**：模型只看截图，不发送整棵 DOM；因此能做 canvas、图标按钮、跨域 iframe。
- **观察 → 动作 → 验证**：`aiAct` / `aiTap` / `aiInput` / `aiWaitFor` / `aiAssert` / `aiQuery` / `aiLocate`；`deepThink` 把任务拆解与元素定位拆成两次模型调用。
- **定位缓存**：计划与 Web XPath 定位结果落在 `midscene_run/cache/*.cache.yaml`，命中后跳过模型；`aiAssert` / `aiQuery` 明确不缓存。缓存命中只是加速，不保证稳定。
- **报告回放**：每一步记录输入、输出、错误、截图和 Agent replay；`summary.json` 供脚本/Agent 读取；`#runner-step=last-error` 直达失败步骤。
- **测试框架**：YAML 步骤 + TypeScript Nodes；生命周期钩子与清理在超时/Ctrl+C 后仍执行；重试、步骤超时、并发。
- **可靠性自述**：AI 断言本质非确定；`aiWaitFor` 每次轮询都花 token；优先使用确定性就绪信号；文件上传受 `fileChooserAllowedDir` 限制。

TestPilot 的差异与底线：已批准的 Test IR、人工审批、证据落盘、测试数据清理、负向探针。我们的回归必须可复现、可解释、失败可归因；ADR-009 明确“AI 只建议，不自动改；回归零 LLM”。因此不能把 Midscene 的 `aiAct`/`aiAssert` 运行循环直接搬进回归执行器。

但测试人员在真实业务系统上仍有两个硬痛点，Midscene 给了成熟启发：

1. 选择器难写、易碎，画布/自定义控件几乎无法用 DOM 定位。
2. “用户实际看到什么”缺少证据：现有断言以文案、HTTP、DB、WS 为主，视觉结果（颜色、选中态、布局、canvas 内容）没有表达方式。

## Decision

**视觉能力只用于生成期与证据期；已批准的回归执行保持零 LLM。**

### 1. 生成期视觉定位建议（V7-9b）

- 在录制/生成草稿时，按需把**当前截图（缩放）+ 裁剪后的 ARIA/DOM 片段**发给视觉模型，让模型提议 1–3 个 Playwright locator 候选与包围盒、置信度。
- 控制台高亮候选，测试人员选定后才写入 IR；IR 里仍然只有确定性 locator，不存截图、不存模型输出。
- 视觉调用遵循 ADR-003：默认只给裁剪片段，整页截图按需；真实/试点环境默认关闭，需按项目显式开启。
- 建议结果可缓存为“定位建议”（键：项目 + 页面 URL 归一化 + 指令 + 截图 pHash），只作为候选，运行时不读取。

### 2. 步骤截图时间线与失败回放（V7-9a）

- 兑现 `policy.screenshots: "always"`：每个成功的步骤在证据目录写 `step-<序号>-<stepId>.png`，记录到 `StepResult.screenshot` 与 `manifest.json`。
- 控制台运行详情在现有“步骤时间线”中显示缩略图，点击打开原图；失败运行提供“跳到失败步骤”，对齐 Midscene 的失败直达体验。
- 截图是本地证据，按现有证据保留策略清理；不进入 IR，不上传外部。

### 3. 探索模式的视觉判定（V7-9c，后置）

- 允许在**探索/诊断**里使用视觉问答（例如“这个列表是否显示了空状态？”），产出的是建议与证据，不参与回归通过/失败门禁。
- 任何 AI 判定必须标注 `oracle: "ai-suggested"`，并在 UI 中与人工批准的断言视觉区分。
- 不缓存 AI 断言结果（Midscene 同样不缓存 `aiAssert`）。

### 4. 借鉴而非照搬的事项

| Midscene 做法 | TestPilot 采用方式 |
|---|---|
| 截图优先、不传 DOM | 生成期采用；回归不调用模型 |
| `aiAct` 自主循环 | 不采用；IR 是唯一执行契约 |
| `aiAssert` 运行时断言 | 仅探索模式，不进门禁 |
| XPath/计划缓存 | IR 中的已批准 locator 就是权威缓存；建议缓存只用于生成期 |
| 报告每步截图 + replay | 采用步骤截图与失败直达；Trace 已提供回放 |
| YAML + TS Nodes | 暂不采用；现有 IR JSON + OpenAPI/cURL 导入优先 |
| 多平台（Android/iOS/桌面） | 后置，Web 业务系统优先 |

### 5. 安全与隐私

- 截图可能含客户数据：只落本地证据目录；发送给视觉模型前必须按项目显式授权（`TESTPILOT_VISION_ENABLED` + 目标白名单），试点/真实默认关闭。
- 视觉模型配置独立于文本 LLM（`TESTPILOT_VISION_*`，OpenAI 兼容 `image_url`），不把密钥写入 IR/日志/证据。当前 DeepSeek Flash 已支持图像理解，可作为默认可用的视觉模型；仍保留独立开关与模型名配置，避免把视觉调用混进普通文本生成。
- 沿用上传白名单与证据脱敏；模型输出只作为建议，不自动改断言、不自动批准。

## Consequences

**正面**

- 画布/自定义控件/图标按钮可用自然语言定位，降低真实业务系统的接入成本。
- 视觉结果有证据，失败更容易解释；步骤截图让“通过”也可复核。
- 回归仍然零 LLM，审批 hash、证据、负向探针体系不被破坏。

**代价**

- 生成期多一次视觉模型调用，需要新的模型配置与成本控制（截图缩放、按需触发）。
- 截图证据占用磁盘，需要继续遵守保留上限。
- 视觉建议可能出错，必须保留人工选择与审阅。

**不做**

- 不在已批准回归中调用 `aiAct`/`aiAssert`/`aiQuery`。
- 不自动应用视觉建议的 locator 或断言。
- 不引入移动端/桌面端运行时。

## Follow-ups

- **V7-9a**：步骤截图时间线与失败回放（P0，当前任务）。
- **V7-9b**：生成期视觉定位建议（P1）。
- **V7-9c**：探索模式视觉判定（P2，不进门禁）。
- 恢复既有 P0：V7-5e 机制接线 → V7-6b WS 证据入口 → V7-0i OpenAPI 导入。

# TestPilot 路线图 v0.8

**唯一执行计划。做完一项再开下一项；状态只维护在这里。**

## 0.1 方向与进度

**方向：** Web 业务系统优先。把「接入 → 生成/审阅 → 可信回归 → 证据 → 清理」做通；试点租户按正常请求运行（查询常用 POST），需要时用 `TESTPILOT_READONLY=1` 开启只读门禁。

**当前核心价值：** 让测试人员不用重复手工回归已有功能，同时保证结果可信、可审阅、可清理。

**已完成（2026-11-18）：**

- 业务接入：V7-7 测试数据清理、V7-0f 命名 API 环境、V7-0h cURL 导入、V7-0g 接口用例编辑、V7-5e 机制接线、V7-6b WS 运行详情、V7-0i OpenAPI 导入
- 实时能力：V7-1b SSE 证据、V7-2a/b 多账号执行与审阅、V7-4a–V7-4b5 实时六场景（text/dedupe/oversize/order/image/reconnect）
- 视觉与证据：V7-9a 步骤截图时间线、V7-9b 录制期 AI 定位、V7-9c 探索期 AI 观察
- 自动审批：`TESTPILOT_AUTO_APPROVE=1` 时，草稿试跑通过且强断言门禁通过后自动批准（`approvedBy: auto:testpilot` + 审计），弱断言/占位断言仍留草稿
- 双账号真实登录：`actors[].account`（`primary`/`alt`），每个 actor 用对应 `TESTPILOT_ENV_REAL_*` / `_ALT_*` 登录；登录失败标注 actor
- 真实只读回归：9 条 `real-*` 用例（通讯录列表/部门筛选/详情/搜索过滤、任务、文档、提醒事项列表/已完成筛选、会议首页），批次 9/9 通过
- 双账号消息：真实环境两个账号同时在线互发一条带 `runId` 的消息并双端断言（`allowMutation` 显式开启，每轮发送一条；前置：两账号已有会话）
- 通用性：探测、内容页基线、生成器均不含业务路由或字段硬编码；真实登录通过可配置适配器接入
- 一键只读套件：真实画像（SPA 路由 + iframe 内容页）→ 生成未覆盖路由的只读用例（确认路径的 URL 断言 + 内容区元素）→ 自动试跑/批准 → 控制台一键批量。实测生成 17 条全部批准（含 6 条内容页），批次 8/8、3/3、6/6 通过
- 语义级只读生成：列表行数（`minCount`）、搜索命中/过滤（`contains`/`notContains` 配对）、详情跳转；命中用例须配对过滤用例通过才自动批准；试点租户数据稀疏，实测语义用例保留为草稿而非制造假阳性
- 风险报告：规则基线 + 持久化 + API（V7-10a），LLM 增强与回退（V7-10b），控制台面板与创建草稿入口（V7-10c）
- 录制多账号：录制表单配置 actor，登录步骤写入 IR（V7-2c）
- 跨 actor 事件等待：`waitForEvent` 等待另一 actor 的 WS/SSE 事件（V7-2d）
- 主动探索：未访问页面、覆盖缺口与未知项建议（V7-13），只建议不自动执行

**本地基线：** 45 条已批准用例（17 demo + 1 pilot + 27 真实，其中 17 条为画像自动生成、6 条为 iframe 内容页；28 条自动批准，均在本地 `data/`，不随仓库分发）、5 个断言 Provider、`pnpm verify` 全绿。

## 1. 红线

- 自动批准只在 `TESTPILOT_AUTO_APPROVE=1` 显式开启、用例试跑通过、且通过强断言门禁时生效；不放宽弱断言门禁；不为让测试通过而改断言。
- 回归零 LLM；AI 只用于生成与探索，不参与通过/失败。
- 真实环境默认按正常请求运行；只读网络门禁由 `TESTPILOT_READONLY=1` 显式开启；密钥只放 `.env`，不进入 IR、日志、证据或 LLM prompt。
- 不改安全默认值：`127.0.0.1` 绑定、CORS 白名单、目标白名单、远程 token。

## 2. 唯一执行顺序

1. [x] **V7-12a 真实环境登录接入（P0）**
   真实环境用例用 `TESTPILOT_ENV_REAL_*` 自动登录；凭据不进 IR/日志；登录失败归 `ENVIRONMENT`。
   _证据：`pnpm --filter @testpilot/runner-web test`、`pnpm --filter @testpilot/test-management test`、`pnpm verify`；真实登录仅本地假页验证；生产站点需 V7-12b/12c 完成后、经明确批准再实测。登录失败不落截图，避免凭据泄漏。_

2. [x] **V7-12b 生产只读门禁（P0）**
   真实环境默认拒绝写请求、上传和有副作用的 UI 步骤；只有显式 `allowMutation` 才放行；审批与审计可见。
   _证据：`pnpm --filter @testpilot/test-ir test`、`pnpm --filter @testpilot/runner-web test`（含 `read-only.test.ts`）、`pnpm --filter @testpilot/test-management test`（`run-options.test.ts`）、`pnpm verify`。IR `policy.allowMutation`；`runOptionsFor` → `readOnlyNetwork`；teardown 写请求同样拦截；UI 触发写请求被拦截时失败归 `ENVIRONMENT` 并记录拦截数；控制台审阅/运行详情徽章；`RunResult.readOnly`/`readOnlyBlockedRequests`。仅本地 HTTP/WS 夹具验证，未对生产站点试跑。仍建议生产账号本身只读——路由/WS 门禁不能替代服务端权限。**2026-11-25 调整**：HTTP 方法不能代表是否写数据（企业系统查询也常用 POST），门禁改为显式 opt-in（`TESTPILOT_READONLY=1`）；试点租户默认按正常请求运行，权限边界交给使用方提供的账号。_

3. [x] **V7-12c 生产证据策略（P0）**
   真实环境默认不落截图/Trace/响应正文，或明确保留期与 PII 提示；证据仍可下载。
   _证据：`runOptionsFor` 对真实源设 `realTarget`；证据采集器强制无截图、无 Trace，`network.json` 去 query/请求体/响应体/头，`ws.json` 去 payload 与 query，`sse.json` 去 data；断言仍在内存使用原始数据。测试：`pnpm --filter @testpilot/evidence test`（`real target ...`）、`pnpm --filter @testpilot/runner-web test`（`realTarget evidence policy ...`）；控制台运行详情「证据已脱敏」徽章已浏览器验证。未对生产站点实测。_

4. [x] **V7-12d 只读回归模板（P0）**
   登录 → 列表 → 搜索 → 筛选 → 详情，5–8 条已批准用例；批量跑通；试点租户按正常请求运行，必要时开启 `TESTPILOT_READONLY=1`。
   _证据（本地 `data/`，不随仓库分发）：9 条 `real-*` 用例（含搜索过滤）全部 `baseUrlRef: "real-env"`，运行均为 `readOnly` + `realTarget`；批次 8/8、8/8、9/9、10/10 连续通过（`batch_mwusbfk1_81b95be0`、`batch_mwusdydu_008f6407`、`batch_mwutcmqw_ff9ff717`、`batch_mwuuiggz_fb192b62`，最后一批含双账号消息用例），自动审批审计 `auto:testpilot`；证据无截图/Trace，network/WS/SSE 无正文与 query。支撑改动：IR/断言 `frame` iframe 支持、UI 断言 `notContains`（搜索后证明成员被过滤，单独使用会被弱断言门禁拒绝）、`runOptionsFor` 解析 IR `baseUrlRef`（此前误用 demo 回退）、批次显式 `testIds`、企业账号登录切换重试。_

5. [x] **V7-10a 风险报告规则基线（P1）**
   RiskReport + 8 条规则 + `data/risk-reports/`；无 LLM 也能用；正反测试。
   _证据：`risk-report.ts` 8 条规则（数据残留、上传缺口、实时送达、权限、覆盖、未知约束、仅 UI 证据、试点/真实写草稿阻断）；`POST/GET /api/detect/:id/risk-report`；`risk-report.test.ts` 覆盖正反与持久化；demo 画像实测生成 3 条风险（file-media、realtime、未知约束），LLM 未参与；报告落 `data/risk-reports/`（已 gitignore）。_

6. [x] **V7-10b 风险分析 LLM 增强（P1）**
   按目标分层取材；严格 JSON schema；去重合并；失败回退规则报告。
   _证据：`enrichRiskReportWithLlm` 只发送能力/信号/未知项/规则摘要，从不含页面文本、截图、Cookie；输出限 12 条建议、字段截断、未知能力/非法分类过滤；与规则项按 category+标题去重且不降级；失败回退规则报告并记录 `llm.error`。测试：`risk-report.test.ts` 的 4 条 LLM 用例（合并/回退/隐私/上限）。demo 实测：`source: rules+llm`、deepseek-flash、5,427 tokens、14 条风险（3 规则 + 11 建议）。POST 支持 `{"llm": false}` 关闭。_

7. [x] **V7-10c 控制台「风险与缺口」面板（P1）**
   severity 排序、证据/assumption 标注、创建草稿入口；不自动批准、不参与门禁。
   _证据：画像页新增「风险与缺口」卡片，展示来源/模型/tokens、阻断项、severity 徽章、能力与证据数、测试思路、待确认问题与「假设」标记；「生成/重新分析」走 `POST /api/detect/:id/risk-report`，失败显示回退原因；「创建草稿」跳到「创建」并预填风险标题+测试思路，不自动提交或批准。浏览器实测：加载既有报告、重新分析得到 `rules+llm`（deepseek-flash，3,419 tokens，13 条风险）、LLM 失败时回退规则报告、创建草稿预填均正常；控制台无报错。_

8. [x] **V7-2c 录制期多账号 UI（P2）**
   录制时可选择与配置 actor；登录步骤写入 IR；仍走审阅批准。
   _证据：录制表单新增「多账号录制」（第二 actor id + primary/alt 凭据），`POST /api/record` 校验 id/重复/上限并按 actor 依次打开录制窗口（`job.stage` 提示当前账号）；`combineActorRecordings` 将登录前事件写入 `actors[].loginSteps`、主步骤标注 actor（primary 省略）、步骤 id 去重；录制器单测覆盖拆分与组合、服务测试覆盖非法 actor 配置；控制台多账号开关已浏览器验证。交互式双窗口录制本身需人工操作，未自动化实测；录制结果仍是草稿，需审阅批准。_

9. [x] **V7-2d 跨 actor waitForEvent（P2）**
   步骤可等待另一 actor 的 WS/事件；超时归 `ENVIRONMENT`；有负向测试。
   _证据：IR 新增 `action: "waitForEvent"` + `waitForEvent {direction, contains, urlIncludes, timeoutMs}`，`step.actor` 指定被观察的 actor；runner 同时轮询该 actor 的 WS 帧与 SSE 事件，匹配即通过，超时 1–60s 可配；超时消息含 `timeout` 归 `ENVIRONMENT`。测试 `wait-event.test.ts` 覆盖 WS 帧、SSE 事件、超时负向；控制台步骤编辑器提供模板（JSON 里指定 actor）。_

10. [x] **V7-13 主动探索（P2）**
    建议未访问页面/链接与补充场景；只作为建议，不自动生成或批准。
    _证据：采集器在路由预算用尽时记录 `unvisited`（≤20，`collector.test.ts` 覆盖）；`buildExplorationSuggestions` 汇总未访问页面、未覆盖能力（复用风险覆盖判定）与画像未知项（合计 ≤20 条，其中问题最多 8 条），只读建议；`GET /api/detect/:id/explore-suggestions`；控制台画像页「主动探索（建议）」面板，浏览器实测生成 file-media / realtime 覆盖缺口与测试思路，无自动生成/批准入口。_

11. [ ] **llm-judge（暂缓）**
    仅探索模式，不进入回归门禁；边界未定前不开工。

12. [x] **V7-14 语义级只读生成（P0）**
    生成的只读用例断言列表结构、搜索命中/过滤与详情，而不是只断言路由；语义用例失败只留草稿，不降级、不自动批准。
    _证据：IR/断言新增 `minCount`（runner 轮询 `locator.count()`，不足归 `PRODUCT_DEFECT`；弱断言门禁拒绝 `minCount < 2` 或无 `target`，正反测试 `ui-count.test.ts`、`validate.test.ts`）；采集器纳入 `tr/td/th/li/table/h1–h4`，元素标注 `inNav`（nav/header/aside/role=navigation|menu|tablist|toolbar），并从重复卡片提取单行文本（跳过导航/交互行，不拼接整块）；生成器排除导航元素、空状态（`暂无…`/`加载中`）与多单元格拼接行，产出 load（`minCount`）、search-match（真实条目的 `contains` + Enter）、search-none（`urlIncludes` + `notContains` 配对）、detail（`contains` + 列表表头 `notContains`）；过滤用例先试跑，命中用例仅在其通过后才自动批准（`routes.ts`）；语义用例失败不降级为 URL 路由，也不再被自动批准。真实目标实测：`/sop` 为空表（`暂无数据`）+ 侧边导航，不再生成伪搜索/详情用例；`/chat` 搜索不过滤消息内容——过滤用例失败，命中用例保留草稿并标注「搜索过滤用例未通过」；`/task`、`/reminder` 无可提取条目，仅有空格输入冒烟。限制：只有 ARIA/表格结构或稳定重复卡片才能提取条目；试点租户数据稀疏时语义用例多为草稿；`minCount` 尚未在真实多行表格上实测（该目标表格仅 1 行）。_


## 3. 明确后置

Android / iOS / Harmony、CI、多项目 / RBAC、自动修复。

## 4. 通用完成标准

- `pnpm verify` 全绿。
- UI 改动浏览器实测。
- 安全与断言改动有正向 + 负向测试。
- 自动批准需同时满足：显式开启、试跑通过、强断言门禁通过，并写审计；证据落盘前脱敏。

## 5. 工作方式

- 基础编码交给 Cursor；Claude 负责任务设计、审查、测试、修复与本文件更新。
- 一次只做一个编号；完成后勾选，并在条目下留一行证据（命令/测试/run id）。
- 发现路线图与现实冲突：先停下记录，不自行改方向。

## 6. 环境配置

本地配置在仓库根目录 **`.env`**（已 gitignore）；模板是 **`.env.example`**。

| 用途 | 变量 |
|---|---|
| LLM（文本） | `TESTPILOT_LLM_API_KEY`、`TESTPILOT_LLM_BASE_URL`、`TESTPILOT_LLM_MODEL`、`TESTPILOT_LLM_PROVIDER`、`TESTPILOT_LLM_TEMPERATURE`、`TESTPILOT_LLM_MAX_TOKENS`、`TESTPILOT_LLM_TIMEOUT_MS` |
| 真实环境 | `TESTPILOT_REAL_BASE_URL`、`TESTPILOT_ENV_REAL_ENTERPRISE_ID`、`TESTPILOT_ENV_REAL_USER_ID`、`TESTPILOT_ENV_REAL_PASSWORD` |
| 真实环境第二账号 | `TESTPILOT_ENV_REAL_ALT_ENTERPRISE_ID`、`TESTPILOT_ENV_REAL_ALT_USER_ID`、`TESTPILOT_ENV_REAL_ALT_PASSWORD`（IR `actors[].account: "alt"`） |
| 业务试点 | `TESTPILOT_PILOT_BASE_URL`、`TESTPILOT_ENV_ADMIN_PHONE`、`TESTPILOT_ENV_ADMIN_PASSWORD` |
| 目标白名单 | `TESTPILOT_ALLOWED_TARGETS`（加入真实/试点域名的 origin） |
| 视觉（默认关） | `TESTPILOT_VISION_ENABLED=1`、`TESTPILOT_VISION_API_KEY`、`TESTPILOT_VISION_MODEL=deepseek-flash`、`TESTPILOT_VISION_BASE_URL`、`TESTPILOT_VISION_TIMEOUT_MS` |
| API 访问 | `TESTPILOT_API_TOKEN`、`TESTPILOT_ALLOWED_ORIGINS` |
| 命名 API 环境 | `TESTPILOT_API_ENVS_FILE` / 本地 `api-envs.json` |
| 自动审批（默认关） | `TESTPILOT_AUTO_APPROVE=1` |
| 真实登录适配器（可选） | `TESTPILOT_REAL_LOGIN_PROFILE_JSON`（按站点配置字段选择器；不配置则用通用账号/密码启发式） |

## 7. 常用命令

```bash
pnpm dev          # demo + API + console
pnpm verify       # 本地唯一硬门槛
pnpm smoke:demo
pnpm negative-probes
```

## 8. 参考

- 方向与视觉边界：[ADR-011](docs/adr/ADR-011-midscene-visual-assist.md)
- 风险分析边界：[ADR-012](docs/adr/ADR-012-risk-analysis.md)
- 断言扩展：[ADR-006](docs/adr/ADR-006-extensible-assertions.md)
- 架构图：`design/架构图.png`、`design/概念图.png`

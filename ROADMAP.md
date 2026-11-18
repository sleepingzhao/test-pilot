# TestPilot 路线图 v0.8

**唯一执行计划。做完一项再开下一项；状态只维护在这里。**

## 0.1 方向与进度

**方向：** Web 业务系统优先。把「接入 → 生成/审阅 → 可信回归 → 证据 → 清理」做通；生产先只读，写流程放 staging。

**当前核心价值：** 让测试人员不用重复手工回归已有功能，同时保证结果可信、可审阅、可清理。

**已完成（2026-11-18）：**

- 业务接入：V7-7 测试数据清理、V7-0f 命名 API 环境、V7-0h cURL 导入、V7-0g 接口用例编辑、V7-5e 机制接线、V7-6b WS 运行详情、V7-0i OpenAPI 导入
- 实时能力：V7-1b SSE 证据、V7-2a/b 多账号执行与审阅、V7-4a–V7-4b5 实时六场景（text/dedupe/oversize/order/image/reconnect）
- 视觉与证据：V7-9a 步骤截图时间线、V7-9b 录制期 AI 定位、V7-9c 探索期 AI 观察

**基线：** 17 条已批准用例（16 demo + 1 pilot）、5 个断言 Provider、`pnpm verify` 全绿。

## 1. 红线

- 不自动批准；不删除或放宽弱断言门禁；不为让测试通过而改断言。
- 回归零 LLM；AI 只用于生成与探索，不参与通过/失败。
- 真实环境默认只读；密钥只放 `.env`，不进入 IR、日志、证据或 LLM prompt。
- 不改安全默认值：`127.0.0.1` 绑定、CORS 白名单、目标白名单、远程 token。

## 2. 唯一执行顺序

1. [x] **V7-12a 真实环境登录接入（P0）**
   真实环境用例用 `TESTPILOT_ENV_REAL_*` 自动登录；凭据不进 IR/日志；登录失败归 `ENVIRONMENT`。
   _证据：`pnpm --filter @testpilot/runner-web test`、`pnpm --filter @testpilot/test-management test`、`pnpm verify`；真实登录仅本地假页验证；生产站点需 V7-12b/12c 完成后、经明确批准再实测。登录失败不落截图，避免凭据泄漏。_

2. [x] **V7-12b 生产只读门禁（P0）**
   真实环境默认拒绝写请求、上传和有副作用的 UI 步骤；只有显式 `allowMutation` 才放行；审批与审计可见。
   _证据：`pnpm --filter @testpilot/test-ir test`、`pnpm --filter @testpilot/runner-web test`（含 `read-only.test.ts`）、`pnpm --filter @testpilot/test-management test`（`run-options.test.ts`）、`pnpm verify`。IR `policy.allowMutation`；`runOptionsFor` → `readOnlyNetwork`；teardown 写请求同样拦截；UI 触发写请求被拦截时失败归 `ENVIRONMENT` 并记录拦截数；控制台审阅/运行详情徽章；`RunResult.readOnly`/`readOnlyBlockedRequests`。仅本地 HTTP/WS 夹具验证，未对 real.example.com 试跑。仍建议生产账号本身只读——路由/WS 门禁不能替代服务端权限。_

3. [ ] **V7-12c 生产证据策略（P0）**
   真实环境默认不落截图/Trace/响应正文，或明确保留期与 PII 提示；证据仍可下载。

4. [ ] **V7-12d 只读回归模板（P0）**
   登录 → 列表 → 搜索 → 筛选 → 详情，5–8 条已批准用例；批量跑通；生产只跑只读。

5. [ ] **V7-10a 风险报告规则基线（P1）**
   RiskReport + 8 条规则 + `data/risk-reports/`；无 LLM 也能用；正反测试。

6. [ ] **V7-10b 风险分析 LLM 增强（P1）**
   按目标分层取材；严格 JSON schema；去重合并；失败回退规则报告。

7. [ ] **V7-10c 控制台「风险与缺口」面板（P1）**
   severity 排序、证据/assumption 标注、创建草稿入口；不自动批准、不参与门禁。

8. [ ] **V7-2c 录制期多账号 UI（P2）**
   录制时可选择与配置 actor；登录步骤写入 IR；仍走审阅批准。

9. [ ] **V7-2d 跨 actor waitForEvent（P2）**
   步骤可等待另一 actor 的 WS/事件；超时归 `ENVIRONMENT`；有负向测试。

10. [ ] **V7-13 主动探索（P2）**
    建议未访问页面/链接与补充场景；只作为建议，不自动生成或批准。

11. [ ] **llm-judge（暂缓）**
    仅探索模式，不进入回归门禁；边界未定前不开工。

## 3. 明确后置

Android / iOS / Harmony、CI、多项目 / RBAC、自动修复。

## 4. 通用完成标准

- `pnpm verify` 全绿。
- UI 改动浏览器实测。
- 安全与断言改动有正向 + 负向测试。
- 不自动批准；证据落盘前脱敏。

## 5. 工作方式

- 基础编码交给 Cursor；Claude 负责任务设计、审查、测试、修复与本文件更新。
- 一次只做一个编号；完成后勾选，并在条目下留一行证据（命令/测试/run id）。
- 发现路线图与现实冲突：先停下记录，不自行改方向。

## 6. 环境配置

本地配置在仓库根目录 **`.env`**（已 gitignore）；模板是 **`.env.example`**。

| 用途 | 变量 |
|---|---|
| LLM（文本） | `TESTPILOT_LLM_API_KEY`、`TESTPILOT_LLM_BASE_URL`、`TESTPILOT_LLM_MODEL` |
| 真实环境 real.example.com | `TESTPILOT_REAL_BASE_URL`、`TESTPILOT_ENV_REAL_ENTERPRISE_ID`、`TESTPILOT_ENV_REAL_USER_ID`、`TESTPILOT_ENV_REAL_PASSWORD` |
| 业务试点 | `TESTPILOT_PILOT_BASE_URL`、`TESTPILOT_ENV_ADMIN_PHONE`、`TESTPILOT_ENV_ADMIN_PASSWORD` |
| 目标白名单 | `TESTPILOT_ALLOWED_TARGETS`（加入真实/试点域名的 origin） |
| 视觉（默认关） | `TESTPILOT_VISION_ENABLED=1`、`TESTPILOT_VISION_API_KEY`、`TESTPILOT_VISION_MODEL=deepseek-flash` |
| API 访问 | `TESTPILOT_API_TOKEN`、`TESTPILOT_ALLOWED_ORIGINS` |
| 命名 API 环境 | `TESTPILOT_API_ENVS_FILE` / 本地 `api-envs.json` |

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

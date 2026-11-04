# TestPilot 实现待办清单

对照 `design/TestPilot_Roadmap_v0.2.docx` 与 `design/架构图.png`。状态：**done** / **partial** / **todo**。

> **当前阶段（2026-11-04）**：V0.1 完成；V0.3 API 断言已在练习环境落地。试点 catalog + **用例1/2 auto-intake** 已批准，本地全量回归 15 条（含 4 条试点）。**下一冲刺**：GitLab 回归、趋势统计、响应体 API 断言。

---

## 0. 仓库与工程基础

| # | 模块 | 说明 | 状态 |
|---|------|------|------|
| 0.1 | Monorepo 目录 | apps / services / packages / examples / design | done |
| 0.2 | 构建与 CLI | `pnpm build`、`pnpm cli validate/run/record` | done |
| 0.3 | 演示环境 | `examples/demo-webapp` + 10 条 catalog 用例 | done |
| 0.4 | 架构 / ADR 占位 | `docs/architecture.md`、`docs/adr/` | partial |
| 0.5 | 工程 ADR 正文 | ADR-001～005 可执行决策 | partial（README + architecture 摘要） |
| 0.6 | CI 自检 | build + IR 校验 + 单测 + **`pnpm smoke:demo`**；本地 **`pnpm verify`** 镜像 workflow | done |

---

## 1. 首个 Sprint（路线图 §11 P0）

| # | 任务 | 完成定义（路线图） | 状态 |
|---|------|-------------------|------|
| P0-1 | **真实业务试点** | 选定 Web 模块；10～20 条手工用例；人工耗时基线 | partial（本地 `docs/pilot-baseline.json` + auto-intake 用例1 草稿） |
| P0-2 | **Test IR v1** | JSON Schema + validator；缺断言拒绝 | partial |
| P0-2b | IR 编译 / 哈希 / 审批流 | `computeIRHash`、`approvedAt`、批准语义校验 | partial |
| P0-3 | **runner-web + CLI** | Playwright + JSON 结果 | partial |
| P0-3b | Runner 可靠性 | 有界等待、重试、定位器回退链；**role+name 精确匹配** | partial（testId 优先 + exact name + text 回退） |
| P0-4 | **录制 → 测试资产** | 语义 Locator；valueRef；控制台录制 | partial（recorder testId-first；API bootstrap 试点草稿） |
| P0-5 | **AI 规划器** | DOM 裁剪 + draft + uncertainties | partial（规则 intake + 可选 DeepSeek；见 `docs/llm.md`） |
| P0-6 | **结果证据** | trace + network.json + 失败截图 | partial（network 驱动 API 断言） |
| P0-7 | **指标对比** | 回归耗时、通过率、与人工基线 | partial（`/api/metrics/summary` + **recentBatches** 趋势） |

**V0.1 发布门槛**

- [x] 练习环境 ≥10 条稳定 Web 用例（catalog seed）
- [x] 测试人员通过控制台执行并看 Trace / 网络（无需写 Playwright）
- [x] 正常回归 **0 次 LLM 调用**
- [x] 真实业务模块替换练习环境（P0-1）— 试点用例可批准并参与回归（本地 `.env`）
- [x] CI 上 Demo Playwright smoke（含工单无附件）

---

## 2. 按包 / 模块（摘要）

| 模块 | 亮点 | 下一步（对齐 design） |
|------|------|------------------------|
| `apps/console` | 侧栏主导航、创建页子菜单、草稿优先列表、失败分型中文 | 试点批量审阅 |
| `services/test-management` | 文件存储、batch、产物、diagnose、bootstrap intakes | PostgreSQL（V0.2）、审计字段 |
| `packages/runner-web` | 步骤机、重试、定位回退、exact role | suite 并行、policy.retry 分型 |
| `packages/planner` | 规则 ticket intake、LLM merge | 更多业务模板；禁止弱断言「提交」 |
| `packages/context-web` | `snapshotPageContext`（≤40 元素） | scope / token 预算 |
| `packages/evidence` | trace、network、分型 | HAR、retention |
| `integrations/gitlab` | `run-regression.sh` | `.gitlab-ci.yml` 示例 + MR 标签触发（V0.3） |

---

## 3. 版本里程碑

| 版本 | 焦点 | 状态 |
|------|------|------|
| **V0.1** | 单机 Web + 控制台 + 录制回放 | **done**（练习 + 试点草稿通道） |
| **V0.2** | 持久化 DB、Locator 回退完善、diagnose+LLM | 进行中（诊断可选 LLM；回归仍 0 LLM） |
| **V0.3** | API 断言、GitLab CI、MR 触发 | partial（练习环境 `/api/users` + `requestRef` + network 断言） |
| **V1.0** | 文档、Docker、多项目 | todo |

---

## 4. 建议实施顺序（当前）

```text
P0-1  控制台批准「用例1 — 提交工单」并在试点回归验证
  ↓
P0-4  录制 / 新增 pilot-intake-presets（用例2～N，仍只产 draft）
  ↓
P0-5  LLM 仅补 assertions/边界；步骤仍以 snapshot + 规则为主
  ↓
V0.2  PostgreSQL + 权限 + 证据 retention
  ↓
V0.3  API 断言（oracle: api-contract）+ GitLab `run-regression.sh` + 趋势
```

---

## 5. Design 对照速查

| Design 章节 | 代码落点 |
|-------------|----------|
| §4 分层 Console / Planner / IR / Runner / Evidence | 见 `docs/architecture.md` |
| §5 定位优先级 testId → role+name | `recorder-web/inject.ts`、`runner-web/run.ts`、`docs/architecture.md` |
| §5.1 不自愈已批准用例 | 诊断只建议；改 IR 需人工保存 |
| §6 IR oracle 字段 | `packages/test-ir` + 控制台审阅 |
| §7.2 REST 草案 | `services/test-management/src/routes.ts`（子集） |
| §8 失败分型 | `packages/evidence` classifyFailure |
| §8 API 断言 | `packages/assertions` `runApiAssertion` + `requestRef` in `packages/fixtures` |
| §9 密钥不进 Git/LLM | `.env` + `valueRef` |

---

## 6. 本地启动

```bash
pnpm install && pnpm build && playwright install chromium
pnpm dev   # 5173 控制台，8787 API，4173 练习应用
```

# TestPilot 实现待办清单

对照 `design/TestPilot_Roadmap_v0.2.docx`。状态：**done** / **partial** / **todo**。

> **当前阶段（2026-11）**：V0.1 可行性 + **Web 控制台为主路径**已打通；练习环境 10 条用例 + 录制/批准/批量回归/证据下载。下一冲刺：**真实试点（P0-1）**、**LLM Planner（P0-5）**、**GitLab CI（V0.3 预研）**。

---

## 0. 仓库与工程基础

| # | 模块 | 说明 | 状态 |
|---|------|------|------|
| 0.1 | Monorepo 目录 | apps / services / packages / examples / design | done |
| 0.2 | 构建与 CLI | `pnpm build`、`pnpm cli validate/run/record` | done |
| 0.3 | 演示环境 | `examples/demo-webapp` + 10 条 catalog 用例 | done |
| 0.4 | 架构 / ADR 占位 | `docs/architecture.md`、`docs/adr/` | partial |
| 0.5 | 工程 ADR 正文 | ADR-001～005 可执行决策 | partial（README 摘要） |
| 0.6 | CI 自检 | `.github/workflows/ci.yml` build + IR 校验 + test-ir 单测 | partial |

---

## 1. 首个 Sprint（路线图 §11 P0）

| # | 任务 | 完成定义（路线图） | 状态 |
|---|------|-------------------|------|
| P0-1 | **真实业务试点** | 选定 Web 模块；10～20 条手工用例；人工耗时基线 | partial（本地 `docs/pilot-baseline.json` + 练习环境 10 条） |
| P0-2 | **Test IR v1** | JSON Schema + validator；缺断言拒绝 | partial |
| P0-2b | IR 编译 / 哈希 / 审批流 | `computeIRHash`、`approvedAt`、批准语义校验 | partial |
| P0-3 | **runner-web + CLI** | Playwright + JSON 结果 | partial |
| P0-3b | Runner 可靠性 | 有界等待、重试、定位器回退链 | partial（role/name 后 text 回退） |
| P0-4 | **录制 → 测试资产** | 语义 Locator；valueRef；控制台录制 | partial（API 启动 auto-intake 试点草稿 + 录制） |
| P0-5 | **AI 规划器** | DOM 裁剪 + draft + uncertainties | partial（DeepSeek 默认可配；见 `docs/llm.md`） |
| P0-6 | **结果证据** | trace + network.json + 失败截图 | partial |
| P0-7 | **指标对比** | 回归耗时、通过率、与人工基线 | partial（`/api/metrics/summary` + baseline 文件） |

**V0.1 发布门槛**

- [x] 练习环境 ≥10 条稳定 Web 用例（catalog seed）
- [x] 测试人员通过控制台执行并看 Trace / 网络（无需写 Playwright）
- [x] 正常回归 **0 次 LLM 调用**
- [x] 真实业务模块替换练习环境（P0-1）— 试点用例可批准并参与回归（本地 `.env`）

---

## 2. 按包 / 模块（摘要）

| 模块 | 亮点 | 下一步 |
|------|------|--------|
| `apps/console` | 首页 / 用例 / **创建**（意图·PRD·录制）/ 结果 | 失败诊断 UI、LLM 草案（可选） |
| `services/test-management` | 文件存储、异步 batch、产物 API、diagnose | PostgreSQL（V0.2） |
| `packages/runner-web` | 步骤机、重试、定位回退 | suite 并行 |
| `packages/planner` | 规则 suggest + planDraft | LLM Provider |
| `packages/context-web` | `snapshotPageContext` | scope / token 预算 |
| `packages/evidence` | trace、network、分型 | HAR、retention |
| `integrations/gitlab` | `run-regression.sh` 可轮询 batch 并失败退出 | MR 触发规则 |

---

## 3. 版本里程碑

| 版本 | 焦点 | 状态 |
|------|------|------|
| **V0.1** | 单机 Web + 控制台 + 录制回放 | **试点 + 练习双轨回归** |
| V0.2 | 持久化 DB、Locator 回退完善、diagnose+LLM 建议 | 起步（诊断可选 LLM；回归仍 0 LLM） |
| V0.3 | API 断言、GitLab CI、MR 触发 | todo |
| V1.0 | 文档、Docker、多项目 | todo |

---

## 4. 建议实施顺序（当前）

```text
P0-1  接入你们真实 Web 模块 URL + 更新 pilot-baseline.json
  ↓
P0-4  在真实页录制 3～10 条 → 控制台批准
  ↓
P0-5  LLM Provider（OpenAI/Anthropic 抽象）+ 仍只产 draft
  ↓
V0.2  PostgreSQL + 权限 + diagnose LLM（按需）
  ↓
V0.3  API 断言 + GitLab MR 回归
```

---

## 5. 本地启动

```bash
pnpm install && pnpm build && playwright install chromium
pnpm dev   # 5173 控制台，8787 API，4173 练习应用
```

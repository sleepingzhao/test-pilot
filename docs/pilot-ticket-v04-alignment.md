# 试点工单提交成功（V4-5 对齐清单）

`pilot-ticket-submit-success` 仍为 **草稿**，须由你在真实试点上校对后批准。本文件记录只读探索项，不自动改线上数据。

## 级联

- 试点表单是 4 个独立的 Element Plus 下拉（省 / 市 / 区县 / 街道），不是单个级联组件；IR 按「打开下拉 → 点选项」逐步选择。
- 若试点使用不同省份/街道命名，仅改 IR 中 `pick-*-option` 的选项文案，勿改审批门禁。

## HTTP

- 提交一次工单，在 Trace/network 中确认 POST URL 片段。
- 默认 `requestRef` 为 `/api/workorder/workOrder/create`（路径级精确匹配）；试点不同则在 `.env` 设置 `TESTPILOT_PILOT_TICKET_API_INCLUDES`。
- 断言 `ticket-submit-success-api` 要求 `statusCode: 200` 且请求体含 `TestPilot-`（与 `详细地址` 中的 `{{runId}}` 一致）。

## DB（可选）

- 默认 IR 不含 DB 断言，避免未配置只读库时阻塞回归。
- 配置 `docs/assertion-db-config.json`（见 `assertion-db-config.example.json`）与只读账号后，再添加使用 `order-by-run-id` 查询的 DB 断言行；表/字段须与线上只读权限一致。
- 未配置 DB 时，UI + HTTP 断言仍可批准；DB 证明留到配置就绪后追加并重新批准。

## 负向

- `pilot-ticket-no-region` 覆盖未选省市区；HTTP 探针见 `pilot-ticket-ir.test.ts`（错误 status 必须失败）。

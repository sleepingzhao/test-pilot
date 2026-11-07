# 试点工单提交成功（V4-5 对齐清单）

`pilot-ticket-submit-success` 仍为 **草稿**，须由你在真实试点上校对后批准。本文件记录只读探索项，不自动改线上数据。

## 级联

- 打开工单表单，记录四级 `cascaderPath` 文案是否与 `examples/pilot-admin/tests/pilot-ticket-submit-success.json` 中 `pick-region` 一致。
- 若试点使用不同省份/街道命名，仅改 IR 中的 `cascaderPath`，勿改审批门禁。

## HTTP

- 提交一次工单，在 Trace/network 中确认 POST URL 片段。
- 若不含默认 `/workorder`，在 `.env` 设置 `TESTPILOT_PILOT_TICKET_API_INCLUDES`。
- 断言 `ticket-submit-success-api` 要求 `statusCode: 200` 且请求体含 `TestPilot-`（与 `详细地址` 中的 `{{runId}}` 一致）。

## DB（可选）

- 配置 `docs/assertion-db-config.json`（见 `assertion-db-config.example.json`）与 `PILOT_DB_URL` 只读账号。
- 断言 `ticket-submit-success-db` 使用 `order-by-run-id` 查询；表/字段须与线上只读权限一致。
- 未配置 DB 时，批准前可暂时移除该断言，或保留为草稿直至 DB 就绪。

## 负向

- `pilot-ticket-no-region` 覆盖未选省市区；HTTP 探针见 `pilot-ticket-ir.test.ts`（错误 status 必须失败）。

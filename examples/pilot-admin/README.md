# 业务试点（Web 管理端）

密码登录场景的 Test IR 模板，位于 `tests/`。不含真实域名与账号。

凭据通过环境变量注入（见仓库根 `.env.example`）：

- `TESTPILOT_PILOT_BASE_URL`
- `TESTPILOT_ENV_ADMIN_PHONE`
- `TESTPILOT_ENV_ADMIN_PASSWORD`

控制台重启 API 后会同步 `【试点】*` 用例；配置 `.env` 后可在用例页批准「密码登录」并参与回归。

## 工单提交成功（P-1）

`tests/pilot-ticket-submit-success.json` 为模板：含登录、`selectCascader` 省市区街道、UI + HTTP 断言。

批准前请在真实试点页面上确认并修改：

- `cascaderPath` 四级文案与线上级联一致；
- UI 成功文案（默认断言「提交成功」）；
- `expect.statusCode` 与 `TESTPILOT_PILOT_TICKET_API_INCLUDES`（默认匹配 URL 含 `/workorder` 的 POST）。

负向用例仍由 auto-intake 草稿 `pilot-auto-ticket-no-attachment` 覆盖「未选省市区」场景。

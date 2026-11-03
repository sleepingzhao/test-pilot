# 业务试点（Web 管理端）

密码登录场景的 Test IR 模板，位于 `tests/`。不含真实域名与账号。

凭据通过环境变量注入（见仓库根 `.env.example`）：

- `TESTPILOT_PILOT_BASE_URL`
- `TESTPILOT_ENV_ADMIN_PHONE`
- `TESTPILOT_ENV_ADMIN_PASSWORD`

控制台重启 API 后会同步 `【试点】*` 用例；配置 `.env` 后可在用例页批准「密码登录」并参与回归。

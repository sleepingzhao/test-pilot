# 业务试点 试点

真实业务参考环境（密码登录 Tab）。Test IR 位于 `tests/`。

凭据通过环境变量注入（见仓库根 `.env.example`）：

- `TESTPILOT_PILOT_BASE_URL`
- `TESTPILOT_ENV_ADMIN_PHONE`
- `TESTPILOT_ENV_ADMIN_PASSWORD`

控制台重启 API 后会同步 `【试点】*` 用例；配置 `.env` 后可在用例页批准「密码登录」并参与回归。

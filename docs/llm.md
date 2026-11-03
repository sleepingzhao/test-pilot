# LLM 配置

TestPilot 在 **生成草稿 / intake / 失败诊断** 时可选用 LLM；**批量回归执行仍为 0 LLM**。

## 快速配置（DeepSeek）

1. 复制仓库根目录 `.env.example` 为 **`.env`**（已在 `.gitignore`）。
2. 打开 [DeepSeek 开放平台](https://platform.deepseek.com) 创建 API Key。
3. 在 `.env` 中替换这一行（仅此一处需要填真实密钥）：

```bash
TESTPILOT_LLM_API_KEY=sk-REPLACE_WITH_YOUR_DEEPSEEK_KEY
```

4. 重启 `pnpm dev` 或 API 进程。

默认参数（可在 `.env` 覆盖）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `TESTPILOT_LLM_PROVIDER` | `deepseek` | `deepseek` / `openai` / `custom` |
| `TESTPILOT_LLM_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容 `chat/completions` |
| `TESTPILOT_LLM_MODEL` | `deepseek-chat` | 模型 id |
| `TESTPILOT_LLM_TEMPERATURE` | `0.2` | 采样温度 |
| `TESTPILOT_LLM_MAX_TOKENS` | `2048` | 单次回复上限 |
| `TESTPILOT_LLM_TIMEOUT_MS` | `45000` | 请求超时 |

占位符 Key（含 `REPLACE_WITH`）会被视为**未配置**，不会发起外呼。

## 验证

- 控制台或 `GET /api/environment` 的 `llm.enabled` 应为 `true`，并显示 `model`。
- 生成 intake 草稿或点击失败 **诊断** 时会消耗 LLM；查看响应里的 `llmUsed` / `llmTokensUsed`。

## 自定义网关

```bash
TESTPILOT_LLM_PROVIDER=custom
TESTPILOT_LLM_BASE_URL=https://your-proxy.example/v1
TESTPILOT_LLM_MODEL=your-model-id
TESTPILOT_LLM_API_KEY=sk-...
```

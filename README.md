# @shuind/dsh-codex-harness

为 DSH 提供可自定义提示词与 Codex 工具的编码模式。

## 功能

- 使用精简codex提示词；对gpt过度拉屎做了少量提示词约束。
- 在 **设置 → 插件 → 插件配置 → Codex Harness** 中查看、编辑或恢复完整提示词。
- 提供 `exec_command`、`write_stdin`、`apply_patch` 和 `update_plan`。
- 支持 Fast 请求、GPT 图片与思考强度和上下文容量。
- 实时显示请求模型、模型回复和上下文压缩状态及耗时。
- Responses 请求优先使用原生 `apply_patch`、hosted `web_search` 和远程压缩，失败时回退到 DSH 实现。

## 安装

```sh
dsh plugin --profile web add @shuind/dsh-codex-harness@0.2.1
```

重启 Web，在 **Agent 预设** 中选择 **Codex 模式**，再创建会话。

## 配置

### 模型

在 DSH 的 Models 中配置支持 OpenAI Responses 的 provider、endpoint、API key 和 GPT 模型。例如：

```yaml
api: openai-responses
baseURL: https://your-responses-endpoint.example.com
apiKeyEnv: OPENAI_API_KEY
```

也可以配合 [dsh-codex-connect](https://github.com/shuind/dsh-codex-connect) 使用 ChatGPT 订阅模型。

### 提示词

打开 **设置 → 插件 → 插件配置 → Codex Harness**。编辑器展示本插件实际注入的完整提示词；保存后从下一次请求开始生效，点击“恢复默认”可回到随包模板。

身份、模型、工作目录、工具说明和 DSH 运行时上下文由对应插件动态提供，不会写死在可编辑模板中。

### Fast 与上下文

- **Fast**：在 Codex 模式的模型菜单中开启，向 Responses 请求发送 `service_tier: "priority"`。
- **上下文容量**：点击输入栏旁的上下文用量指示器，可设置 `1K`–`1000K` tokens；下一次请求和自动压缩使用该值。

## License

MIT

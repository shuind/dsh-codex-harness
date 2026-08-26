# @shuind/dsh-codex-harness

在 DSH 中提供 Codex preset：引入 Codex 风格的系统提示词与工具契约，支持图片输入、可选思考强度、Fast 优先级请求、OpenAI Responses 网页搜索与远程压缩，以及在 Web 设置上下文容量；旨在给来源于Codex的token提供适配harness，并兼容享受DSH生态。

## 功能

- **Codex coding-agent 提示词**：提供 Codex 风格的系统提示词、工具契约和编码工作流。
- **Codex 工具**：`exec_command`、`write_stdin`、`apply_patch`、`update_plan`。
- **GPT 能力补全**：为 GPT 系列模型补充图片输入和思考强度选项；不会覆盖用户已有的显式配置。
- **Fast**：仅在 Codex preset 的模型选择菜单中显示，开启后向 Responses 请求发送 `service_tier: "priority"`。
- **远程搜索与压缩**：OpenAI Responses 请求默认优先使用 hosted `web_search` 和 `/responses/compact`；失败时回退到 DSH 的本地实现。
- **上下文容量**：在 Web 中设置 `1K`–`1000K` tokens，设置值作用于下一次请求。

## 安装

```sh
dsh plugin --profile web add @shuind/dsh-codex-harness@0.1.15
```

重启 Web，创建新会话，在模式菜单中选择 **Codex 模式**。

## 配置

在 DSH 的 Models / `llm-pi-ai` 中配置 Responses provider、endpoint、API key 和模型。例如：

```yaml
api: openai-responses
baseURL: https://your-responses-endpoint.example.com
apiKeyEnv: OPENAI_API_KEY
```

模型列表中填写中转站实际支持的 GPT 模型。

## 请求设置

### Fast

Fast 与 `reasoning_effort` 独立。开启 Fast 后，GPT Responses 请求会携带：

```json
{
  "service_tier": "priority"
}
```

Fast 设置保存在 `codex` 命名空间，只对 Codex preset 生效。

### 上下文容量

点击 Web 顶部的上下文使用量指示器，可以设置下一次请求的上下文容量。上方 meter 显示当前请求的实际容量；修改设置后，需要发送下一次请求才会更新。

上下文容量使用整数 K tokens，范围为 `1K` 到 `1000K`。实际可用上限仍取决于模型和中转站支持情况。

## 自定义 preset

如果直接使用插件提供的 Codex 模式，不需要自定义 preset。只有在想自己组合工具、提示词，或修改插件配置时才需要。

自定义 preset 放在 `${DSH_HOME:-$HOME/.dsh}/.agent-presets/<id>/` 目录中。

### 示例：创建一个带协作提示词的 Codex preset

例如创建目录 `${DSH_HOME:-$HOME/.dsh}/.agent-presets/my-codex/`，并写入 `agent.cordis.yml`：

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: 你是一个使用 DSH 工具工作的 Codex 编程助手。

- id: codex-tools
  name: '@shuind/dsh-codex-harness'
  config:
    collaborationPrompt: true
```

再写入 `preset.yml`，让 Web 中显示更清晰的名称：

```yaml
name: My Codex
description: 使用 Codex 工具并开启可选协作提示词。
order: 10
```

然后在 Web 的 **Agent 预设** 中选择 `My Codex`，再新建会话。这个 preset 会加载 Codex 工具，并开启协作提示词；网页搜索、远程压缩和 Skills 等其他功能需要在同一个 `agent.cordis.yml` 中按需添加。

如果需要完整的 Codex 工具、搜索、压缩和 Skills 组合，建议直接使用随包提供的 `presets/codex`。

### 可选协作提示词（私货）

这段提示词默认关闭，不会注入系统提示词。需要时，在自定义 `agent.cordis.yml` 中开启：

```yaml
- id: codex-tools
  name: '@shuind/dsh-codex-harness'
  config:
    collaborationPrompt: true
```

开启后，Codex preset 会在系统提示词中注入以下协作要求：

```text
Ask, align, and clarify whenever uncertainty, assumptions, tradeoffs, or decisions could materially affect the outcome.
Understand the user's full picture, align it with your own, and leave no hidden assumptions or gaps.
Keep only the essential logic and core actions. There's no need to explain or test what was removed or why something wasn't done.
Convey enough valuable information with as few words as possible. Stay focused on the end goal.
Solve problems by thinking from first principles and at a higher level.
Make things as effortless as possible for the user.
```

## 注意事项

- preset 在创建会话时确定；已有会话不会自动切换到 Codex 模式。
- GPT 模型的图片输入和思考强度属于能力补全；用户已明确配置的字段会被保留。
- hosted search、远程压缩以及 reasoning 参数的可用性取决于实际 Responses 中转站和模型。

## License

MIT

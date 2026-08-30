# @shuind/dsh-codex-harness

使用精简版 Codex 提示词和工具，以及改善体验的功能。

## 功能

- **精简 Codex coding-agent 提示词**：使用精简版系统提示词；身份、模型和工作目录由 `dsh-persona` 提供，避免重复的 Harness 身份说明，同时保留必要的工具契约和编码工作流。
- **Codex 工具**：`exec_command`、`write_stdin`、`apply_patch`、`update_plan`；`apply_patch` 匹配失败时会显示文件、hunk、行号、可见空白和附近文件内容，便于修正上下文。
- **后台任务**：`exec_command` 支持 `run_in_background: true`，立即返回 DSH `job_id`；使用 `job_output` 读取输出、`job_kill` 停止任务。任务完成时，忙碌中的 agent 会在下一步收到 inbox 注入；空闲 agent 默认保持安静，等下一次唤醒时再处理完成消息。
- **GPT 能力补全**：为 GPT 系列模型补充图片输入和思考强度选项；不会覆盖用户已有的显式配置。
- **Fast**：仅在 Codex preset 的模型选择菜单中显示，开启后向 Responses 请求发送 `service_tier: "priority"`。
- **旧版 Web 兼容**：在未提供新版模型设置/上下文设置 slot 的 DSH Web 中，Fast 和上下文容量会自动回退到旧版 composer inline slot；上下文容量使用紧凑按钮和弹层，不占用整行；client 注入不依赖纯类型 slot 包。
- **Responses 原生 apply_patch**：在 GPT Responses 请求的插件传输边界，把普通 JSON function tool 改写为 `type: "custom"` + OpenAI `lark` grammar；下一轮历史同步改写为 `custom_tool_call`。如果中转站拒绝 custom tool，则自动回退到普通 function tool，不改变 DSH 工具执行器。
- **远程搜索与压缩**：OpenAI Responses 请求默认优先使用 hosted `web_search` 和 `/responses/compact`；失败时回退到 DSH 的本地实现。
- **远程压缩用量**：`/responses/compact` 返回标准 `usage` 时，插件会把 `input_tokens`、缓存读写和 `output_tokens` 原样拆分为 DSH 的用量字段；不再把远程压缩伪造成 `0`。中转站缺失或返回不一致的 usage 时，插件不会编造数字。
- **上下文容量**：在 Web 中设置 `1K`–`1000K` tokens，设置值作用于下一次请求。
- **自动压缩阈值**：Codex preset 的自动压缩会读取最新请求持久化的有效上下文容量；例如设置 `400K` 时，默认 `80%` pressure threshold 是 `320K`，不会错误地按适配器默认 `262,144` 在约 `210K` 提前触发。
- **活动状态**：Codex 请求模型、接收模型回复或进行上下文压缩时，在 `Deep diving...` 右侧显示对应阶段和耗时，让长时间 Deep Diving 不再像卡住。

## 安装

```sh
dsh plugin --profile web add @shuind/dsh-codex-harness@0.1.29
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

点击 Web 顶部的上下文使用量指示器，可以设置下一次请求的上下文容量。上方 meter 显示当前请求的实际容量；修改设置后，需要发送下一次请求才会更新。Codex preset 的自动压缩也使用这个已经持久化的有效容量。

上下文容量使用整数 K tokens，范围为 `1K` 到 `1000K`。实际可用上限仍取决于模型和中转站支持情况。

### 活动状态

Codex 发起模型请求时，Web 会在 `Deep diving...` 右侧显示 `请求中... · Ns`；收到首个非空模型 token（非流式适配器则收到 `assistant/message`）后切换为 `回复中... · Ns`。模型回复结束、进入工具调用、压缩结束或下一轮开始后自动隐藏。该状态由 Host 的 `sessionProjections` 投影驱动，因此本地压缩和远程 `/responses/compact` 都会显示同一种状态。

如果当前 DSH 组合没有加载 projection 服务，插件会跳过注册，客户端也会自动隐藏这行，不影响普通会话。

## 随包提供的 Codex preset

安装插件后，首次启动对应的 DSH profile 时，插件会安装两套随包提供的 preset：

- **Codex 模式**：使用精简版 Codex 提示词和工具，以及改善体验的功能。
- **Codex 协作模式**：额外加入协作提示词，预期获得更好的体验。

它们分别位于 `${DSH_HOME:-$HOME/.dsh}/.agent-presets/codex/` 和 `${DSH_HOME:-$HOME/.dsh}/.agent-presets/codex-collaboration/`。如果对应目录已经存在，插件会保留你的文件，不会覆盖自定义内容。

在 Web 的 **Agent 预设** 中选择 **Codex 模式** 或 **Codex 协作模式**，再新建会话即可使用随包提供的 Codex 工具、网页搜索、远程压缩和 Skills 组合。两套 preset 共用 Fast、思考强度、GPT 图片输入和上下文容量设置；只有系统提示词是否包含协作指导不同。

## 自定义 preset

只有在想自己组合工具、提示词，或修改插件配置时才需要自定义 preset。自定义 preset 放在 `${DSH_HOME:-$HOME/.dsh}/.agent-presets/<id>/` 目录中。

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

- id: codex-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
  config:
    completionDelivery: quiet
```

再写入 `preset.yml`，让 Web 中显示更清晰的名称：

```yaml
name: My Codex
description: 使用 Codex 工具并开启可选协作提示词。
order: 10
```

然后在 Web 的 **Agent 预设** 中选择 `My Codex`，再新建会话。这个 preset 会加载 Codex 工具，并开启协作提示词；网页搜索、远程压缩、后台任务控制和 Skills 等其他功能需要在同一个 `agent.cordis.yml` 中按需添加。若希望自定义 preset 也修正自动压缩阈值，请在 compaction 隔离组中使用 `@shuind/dsh-codex-harness/compaction` 替代 `@deepseek-ai/dsh-compaction-basic`。

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
Gather enough context from the user then achieve the user's goal through the clearest, most effective path.
Keep only the essential logic and core actions. There's no need to explain or test what was removed or why something wasn't done.
Convey enough valuable information with as few words as possible. Stay focused on the end goal.
Solve problems by thinking from first principles and at a higher level.
```

## 注意事项

- preset 在创建会话时确定；已有会话不会自动切换到 Codex 模式。
- GPT 模型的图片输入和思考强度属于能力补全；用户已明确配置的字段会被保留。
- hosted search、远程压缩以及 reasoning 参数的可用性取决于实际 Responses 中转站和模型。
- `apply_patch` 的 custom grammar 改写只作用于 GPT Responses 请求；中转站必须接受 OpenAI custom tools 和 Lark grammar。拒绝时插件会自动发送原始 JSON function-call 请求。

## License

MIT

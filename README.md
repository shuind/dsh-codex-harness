# @shuind/dsh-codex-harness

为 DSH 提供可自定义提示词与 Codex 工具的编码模式。

本地开发中的新版支持直接编辑 DSH 预设、加入 Codex 能力及另存副本，详见 [预设编辑说明](docs/preset-library.md)。尚未发布到 npm。

## 功能

- 使用精简codex提示词；对gpt过度拉屎做了少量提示词约束。
- 在 **设置 → 插件 → 插件配置 → Codex Harness** 中查看、编辑或恢复完整提示词。
- 在 **设置 → 插件 → 插件配置 → Codex Harness** 中展开 **预设编辑**：Codex 模式和其它预设处于同一级，打开时默认选中 Codex。用户预设可直接编辑；DSH 内置预设只读，先创建可编辑副本。
- 提供 `exec_command`、`write_stdin`、`apply_patch` 和 `update_plan`。
- 支持 Fast 请求、GPT 图片与思考强度和上下文容量。
- 实时显示请求模型、模型回复和上下文压缩状态及耗时。
- Responses 请求优先使用原生 `apply_patch`、hosted `web_search` 和远程压缩，失败时回退到 DSH 实现。

## 安装

```sh
dsh plugin --profile web add @shuind/dsh-codex-harness@latest
```

重启 Web，在 **Agent 预设** 中选择 **Codex 模式**，再创建会话。

### 宿主版本

Codex 模式使用 `@deepseek-ai/dsh-persona` 的 `prefix` 配置。宿主必须提供
`@deepseek-ai/dsh-persona >=0.1.3-alpha.2`；当前的 DSH `0.1.5-rc.2` 满足此要求。
更早的 persona 版本只接受 `text`，会在加载预设时报告缺少 `prefix`。

预设管理还需要 DSH 的 `agent-presets`、`api-remotes`、`atomic-write` 和 `typert-protocol` 接口至少为
`0.1.5-rc.2`。较旧宿主仍可加载 Codex 工具层，但不会注册预设编辑入口。

### 已有自定义预设

插件会自动更新未修改过且带有本插件管理标记的旧预设。包含用户修改的预设会保留，
需要手动迁移：先备份 `$DSH_HOME/.agent-presets/codex-collaboration`，再打开其中的
`agent.cordis.yml`，将 `@deepseek-ai/dsh-persona` 配置下的 `text:` 改为 `prefix:`，
保留后面的提示词内容，然后重启 DSH 并重新选择 Codex 模式。若预设没有该管理标记，
也应按同样步骤迁移；不要覆盖已有的自定义提示词。

## 配置

### 模型

在 DSH 的 Models 中配置支持 OpenAI Responses 的 provider、endpoint、API key 和 GPT 模型。例如：

```yaml
api: openai-responses
baseURL: https://your-responses-endpoint.example.com
apiKeyEnv: OPENAI_API_KEY
```

也可以配合 [dsh-codex-connect](https://github.com/shuind/dsh-codex-connect) 使用 ChatGPT 订阅模型。

### 预设编辑

打开 **设置 → 插件 → 插件配置 → Codex Harness**，展开其中的 **预设编辑**，从选择器中选择 Codex 或其它预设。编辑器只展示名称、说明、Codex 提示词和能力开关，不要求直接编辑 YAML。

用户预设可以直接保存。DSH 内置预设不能修改，点击 **创建可编辑副本** 后再保存；副本会自动加入同一个选择器，也会保留源预设的工具、插件和其它配置。普通预设还可以在编辑时加入 Codex 能力。活动状态属于全局显示设置，远程上下文压缩、托管网络搜索、终端、补丁、计划和 Codex 提示词属于 Codex 模式能力，并可随预设保存。

### Fast 与上下文

- **Fast**：在 Codex 模式的模型菜单中开启，向 Responses 请求发送 `service_tier: "priority"`。
- **上下文容量**：点击输入栏旁的上下文用量指示器，可设置 `1K`–`1000K` tokens；下一次请求和自动压缩使用该值。

## License

MIT

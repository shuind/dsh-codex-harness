# @shuind/dsh-codex-harness

给 DeepSeek Harness（DSH）用的 Codex 风格插件：自带一套混合模式编码预设（`codex-hybrid`）和 Codex 常用工具，支持对任意预设按工具做启用 / 替换 / 延迟加载 / 隐藏，也可以单独调整预设提示词，并针对 OpenAI Responses API 与中转站补全了常用请求增强。

当前版本 `0.3.2` 适配 **DeepSeek Harness `0.2.2-rc.1`–`0.2.2-rc.5`**（`engines.dsh: >=0.2.2-rc.1 <=0.2.2-rc.5`）。

## 安装

### 从插件市场 / npm 安装

在 Harness 的 **插件 → 添加插件** 中输入 `@shuind/dsh-codex-harness`（或指定 `@shuind/dsh-codex-harness@0.3.2`），安装后按提示重启 Harness 即可。

### 从离线包安装（GitHub Release）

1. 在 [Releases](https://github.com/shuind/dsh-codex-harness/releases) 页面下载对应版本的 `.tgz` 安装包（如 `shuind-dsh-codex-harness-0.3.2.tgz`）。
2. 打开 Harness 桌面端的 **插件 → 添加插件**，填入该 `.tgz` 文件的本地路径确认安装，然后重启 Harness。

## 功能概览

- **Codex 常用工具**：
  - `exec_command` / `write_stdin`：支持长会话命令执行、分段继续读取输出、Windows `terminal-pwsh` PTY 交互终端，以及流输出对称截断。
  - `apply_patch`：用 Codex `Begin/End Patch` 补丁语法批量改文件，对话界面展示内联 Diff 卡片，保留原文件 BOM / CRLF 编码细节。
  - `update_plan` / `read_image`：轻量任务计划工具，以及图片读取支持（宿主挂载附件服务时生效）。
- **Codex 混合模式预设（`codex-hybrid`）**：
  - 把 `exec_command`、`write_stdin`、`apply_patch`、`update_plan`、`activate_tools` 等高频工具留在原生工具栏里直调；把 `read`、`glob`、`grep`、`web_fetch` 等检索类工具收进 `run_code` 代码沙箱（PTC，Programmatic Tool Calling）并发批处理，减少模型来回调用轮次。
  - 把 `create_goal`、`get_goal`、`ralph`、`subagent_fork`、`update_goal`、`workflow` 等低频工具设为按需延迟加载，模型用到时通过 `activate_tools` 拉起；触发本地或远程上下文压缩后，超过 `2` 轮未再使用的工具会自动收回，减少后半场无效 schema 占用。
- **给其他预设改工具、改提示词**：
  - 打开 **设置 → 内置插件 → Codex Harness → 预设方案**，选中任意预设即可逐个工具切换 **启用 / 替换 / 延迟 / 隐藏**：
    - 可将 `bash` / `pwsh` 替换为 `exec_command + write_stdin`
    - 可将 `todo_write` 替换为 `update_plan`
    - 可选将 `edit` / `write` 替换为共用 `apply_patch`
  - 同一页面可单独覆写该预设允许编辑的提示词段，不会修改原预设源文件或其他预设；规则保存后对**新创建的会话**生效，已经打开的老会话会继续保留启动时的配置。
- **对话快捷控件与状态**：
  - **上下文大小**：点输入框右下角容量按钮可直接切换预设档位（`64k`–`1000k`）或手填数值（最高 `1000k`），在「运行偏好」里可开关显示。
  - **Fast 模式**：使用 OpenAI Responses 接口或中转站时，点右下角开关可开启 `service_tier: "priority"` 加速通道。
  - **远程压缩与 `/compact`**：支持 `/compact remote`（优先走服务端的 `/responses/compact`）和 `/compact local`（强制走 Harness 本地摘要压缩），输入框有命令补全菜单；若模型上下文预算设得小于 `80K`，接近上限时会自动做一次截断压缩兜底。
  - **运行状态条**：在输入框上方实时显示当前模型「请求中 / 回复中 / 正在压缩上下文」及已耗时秒数。

## 接入模型（官方接口 / 中转站 / 订阅）

- **用插件自带工具与预设**：不挑模型，DeepSeek 等模型都可以正常使用 `exec_command`、`apply_patch`、`codex-hybrid` 和工具裁剪。
- **用 Responses API 相关功能**（原生 `apply_patch`、远程 `/responses/compact`、托管联网搜索、`Fast` 通道等），通常按下面两种方式之一接入：
  1. **OpenAI 官方接口或支持 Responses API 的中转站**：在 Harness 模型设置里把接口协议选为 `openai-responses`，填入中转站 `baseURL` 和 API Key 即可。若中转站本身不支持 `/responses/compact` 或托管联网搜索，插件会自动回退到 Harness 本地实现，不必手动禁用。
  2. **搭配 [dsh-codex-connect](https://github.com/shuind/dsh-codex-connect) 使用 ChatGPT 订阅账号**：直接配合即可，插件会自动把搜索、`Fast` 档位和逐模型上下文上限交回 `dsh-codex-connect` 管理，输入框右下角的容量按钮也会直接联动它的逐模型配置。

## 更多说明

- 跨预设工具替换、延迟加载与回收细则：[docs/tool-policy.md](docs/tool-policy.md)
- 预设结构与提示词覆盖说明：[docs/preset-library.md](docs/preset-library.md)
- 更新日志：[CHANGELOG.md](CHANGELOG.md)
- 源码构建与发包说明：[RELEASE.md](RELEASE.md)

## License

MIT。插件图标为本项目原创，按同一许可分发。

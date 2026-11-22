# Changelog

## 0.3.1 (2026-11-22)

- **适配 DeepSeek Harness `0.2.2-rc.5`**：
  - 将 `engines.dsh` 范围扩展至 `>=0.2.2-rc.1 <=0.2.2-rc.5`，并将全部 `@deepseek-ai/dsh-*` 开发依赖与传递 peer 依赖对齐验证到 `0.2.2-rc.5`。
- **修复从 GitHub 源码安装触发的 `TS2883` 构建错误**：
  - 为 `src/policy/rule-resolver.ts` 与 `src/entries/preferences.ts` 的 `Config` 补齐显式可移植类型标注，避免在 `pnpm v11` 严格依赖布局下导出 `.d.ts` 时引用非直接依赖 `@deepseek-ai/cosmokit`。
- **市场元数据维护**：
  - 新增 256px 栅格市场图标 `assets/codex-icon-256.png`，并将 `screenshots.json` 迁移为相对路径。

## 0.3.0 (2026-11-18)

本版本整合 `0.2.22`–`0.2.40`（本地重构与适配，含 npm `0.2.32-dsh-v0.2.2-rc.1` 之后的演进）并新增以下改进与修复，作为面向 DeepSeek Harness `0.2.2-rc.1`–`0.2.2-rc.4`（`>=0.2.2-rc.1 <=0.2.2-rc.4`）的 `0.3.0` 正式发布版本：

- **`0.2.2-rc.4` 开发依赖与类型适配**：
  - 将全部 `@deepseek-ai/dsh-*` 开发依赖与传递 peer 依赖对齐验证到 `0.2.2-rc.4`，并将 `zod` 升级至 `4.6.6` 与 `0.2.2-rc.4` 运行时保持一致，消除跨版本 `ZodType` 类型实例化膨胀。
- **远程压缩与本地压缩统一回收冷工具**：
  - 移除 `compaction/end` 中针对远端加密压缩（`<codex-remote-compaction>` / `<dsh-codex-connect-native-compaction-v1>`）跳过回收的限制；无论本地摘要还是远程加密压缩，压缩进行期间仍维持工具集合不变以命中原前缀缓存，压缩完成后统一回收超过 `2` 轮（`DEFERRED_RECENT_TURN_WINDOW`）未再使用的已激活延迟工具，避免冷工具在历史被压缩折叠后被 `dsh-llm` 退回顶层 `body.tools` 常驻占用。

- **输入框快捷上下文调控与界面精简**：
  - 在对话输入框右下角新增紧凑的上下文容量按钮与菜单（预设 `64k`–`1000k` 档位及 `k` / 数值输入，最高 `1000k`，可在运行偏好关闭显示）；`openai-codex` 路由直接读写 `dsh-codex-connect` 的逐模型 `contextWindowOverrides` 并拉取 `/plugins/dsh-codex-connect/models` 动态上限，其它 GPT 路由读写本地 `contextWindow` 配置。
  - 在运行偏好设置页隐藏与输入框快捷按钮重复的“上下文大小 (tokens)”数字输入框，保留后台 schema 与非 `openai-codex` 路由已有配置兼容。
- **`/compact [remote|local]` 命令与交互弹层**：
  - 新增 Codex 感知的 `/compact` 命令并接入输入框指令选择弹层；支持显式传入 `remote` 或 `local`（`/compact local` 强制本地摘要压缩并抑制外部原生远端压缩），映射宿主 `ManualCompactionError` 错误反馈。
- **小窗口自动压缩回退与上下文上限保护**：
  - 当 GPT 会话有效上下文窗口低于 `80K`（低于宿主默认预留阈值）时，按 `0.8` 阈值自动对最旧安全区间执行截断压缩，保留近期约 `0.16` 上下文及首条系统消息并确保 tool call/result 配对完整。
  - 在 `compaction` 阶段按模型真实上限放宽遗留 `pi-ai` 上下文溢出诊断修补阈值。
- **`codex-hybrid` 预设提示词变量兼容修复**：
  - 移除 `deployment:persona-prefix` 与 `DEFAULT_CODEX_PERSONA` 中 DSH `0.2.2-rc.1` 未注册的 `{{cwd}}` 变量（工作目录改由宿主 `working-directory:current` 运行时上下文提供），避免新会话首轮报 `unknown prompt variable "{{cwd}}"`；同时为手动保留 `{{cwd}}` 的自定义覆写提供 `working-directory:current` 自动提取兜底，并在预设运行时测试补充 `renderPrompt()` 校验。

## 0.2.40-dsh-v0.2.2-rc.1 (local, unpublished)

- 消除与 `dsh-codex-connect` 的剩余功能与界面重叠：
  - **Fast 开关**：输入框右下角仅在非 `openai-codex` 的 GPT 模型（或无 `modelDirectories` 的旧宿主）下展示；切到 `openai-codex`（已有三档菜单）或非 GPT 模型（如 DeepSeek）时自动隐藏；`agent/request` 对 `openai-codex` 不再注入 `serviceTier`。
  - **上下文窗口**：`syncCodexContextWindow`、`applyCodexRequestSettings`、`CodexCompactionEngine` 与 `llm/stream` 均不对 `openai-codex` 覆盖容量，保留 `dsh-codex-connect` 的逐模型预算与 `contextWindowOverrides`。
  - **联网搜索与补丁语法**：`openai-codex` 路由关闭 `hostedWebSearch` Wire 改写以直接走 Codex Connect 搜索服务，同时保留互补的 `apply_patch` Lark 自定义语法升级。
  - **工具说明**：补全 `view_image`、`codex_connect_image_generate`、`codex_connect_quota` 三个可选工具的中英文设置页说明。

## 0.2.39-dsh-v0.2.2-rc.1 (local, unpublished)

- 让路 `dsh-codex-connect` 并对齐 Responses V2 远程压缩能力：
  - `openai-codex` 路由不再尝试读取 `llm-pi-ai` 或拦截改写 `compaction_trigger` 与既有 `service_tier`，`/compact local` 会显式抑制外部原生压缩触发，冷工具回收同时识别 `<dsh-codex-connect-native-compaction-v1>` 标记。
  - 独立 `llm-pi-ai` 路由（无 `dsh-codex-connect` 时）新增 V2 双层检查点（按自适应预算保留最高 `64 KB` 近期用户原话 + `compaction` 密文，向后兼容 V1 标记）、基于 `isCompactCheckpointSource` 的可信来源防伪、DSH `0.2.2` 系统提示词 `instructions` 提取与 `tool-addition` / `tool-removal` 兼容、`openai-codex-responses` `/responses` `compaction_trigger` SSE 解析，以及 `429/502/503/504` 短时重试。

## 0.2.38-dsh-v0.2.2-rc.1 (local, unpublished)

- 为按需延迟加载（`deferLoading`）新增压缩前轮次热度账本：在 `activate_tools` 与延迟工具实际执行时零阻塞记录最近使用轮次，并在本地摘要压缩（`compaction/end`）完成且非远端加密压缩时，自动回收超过 `2` 轮（`DEFERRED_RECENT_TURN_WINDOW`）未再使用的冷工具；压缩摘要生成过程保持工具列表不变以复用热 KV 缓存，活跃工具与 `codex:deferred-tools` 静态目录保持不动。

## 0.2.37-dsh-v0.2.2-rc.1 (local, unpublished)

- 补全设置页全部 65+ 个 DSH 官方工具（含 `job_list`、`list_subagent_models`、`schedule_*`、`session_*`、`terminal_*`、`team_*`、`stagehand_*`、`plugin_*`、`cordis_*` 等）、`dsh-codex-connect` 审批工具以及动态 `mcp__*__*` 扩展工具的保留术语中文说明，替代英文原描述截断展示。

## 0.2.36-dsh-v0.2.2-rc.1 (local, unpublished)

- 移除旧非混合预设 `codex-collaboration`（`Codex 模式`），仅保留唯一的 **Codex 混合模式**（`codex-hybrid` / `preset-codex-hybrid`），并在 `codex-hybrid-executor` 新增 `hiddenTools` 隐藏冗余的 `todo_write` 工具。
- 重构 **Codex Harness** 设置界面：贴合桌面端原生卡片与分段标签设计，移除多余 `高级…` 二级入口，将全部/已修改/延迟筛选与 `启用 / 替换 / 延迟 / 隐藏` 分段操作按钮整合到同一视图，屏蔽 Codex 自带工具误报的 `按条件可用` 标签并改用吸底待保存栏。

## 0.2.35-dsh-v0.2.2-rc.1 (local, unpublished)

- 新增实验性非对称混合模式执行器 `@shuind/dsh-codex-harness/hybrid-executor`（`CodexHybridExecutor`）与预设 `codex-hybrid`（`preset-codex-hybrid`）：`apply_patch`、`exec_command`、`write_stdin`、`update_plan`、`activate_tools` 等高频工具保留原生 wire 调用，只读检索类工具归入 `run_code` SDK 批量并发执行。
- 新增按需延迟加载工具能力（`deferLoading: true` + `activate_tools`），在混合模式和工具方案策略中默认延迟低频工具并保持提示词与请求缓存前缀稳定。
- 强化核心工具与 Responses 协议适配：支持 `read_image`、Windows `terminal-pwsh` PTY 与 64 会话 LRU 清理、`apply_patch` Diff 卡片、工作流/计划模式兼容、`zstd` 请求重写与 `/responses/compact` 远程压缩及回退。
- 完成 `src/` 与 `tests/` 分层模块化重构，保持 8 个 `lib/*.js` 导出入口与浏览器客户端隔离不变。

## 0.2.34-dsh-v0.2.2-rc.1 (local, unpublished)

- 请求状态改放输入框卡片外上方的原生 dock 区域，不再占用输入框右侧操作栏；原生思考提示保持不动。
- 沿用消息投影、计时、隐藏设置和回收逻辑，继续不使用消息区 DOM 定位或悬浮层。

## 0.2.33-dsh-v0.2.2-rc.1 (local, unpublished)

- 请求/回复/压缩状态移到输入框右侧、发送按钮之前的原生扩展位，以紧凑单行显示，不再悬浮在消息区。
- 删除跟踪宿主“深度求索中”DOM、每帧测量坐标及状态浮层 portal；计时和状态来源保持不变，长标签在窄屏内截断，不替换宿主原有思考提示。

## 0.2.32-dsh-v0.2.2-rc.1 (2026-11-13)

- 删除共享 Codex 模板编辑界面，改为跟随当前所选预设的提示词；工具与提示词使用同一份预设草稿和“保存此预设”，不再写入旧全局模板字段。
- 新增预设提示词只读目录及精确指令段覆盖；仅可核验的原生身份前缀/后缀与 Codex 操作指南可编辑，未知或无法安全覆盖的段保持只读，不把表达式或全局 Codex 默认当成其它预设原文。
- 按 Agent 规则快照注册同名作用域指令段，保留 complete/interpolate/顺序和双 owner 回收；清除覆盖恢复原始指令，不改原始预设声明、其它预设或宿主工具/权限规则。
- 旧共享模板数据后台兼容保留；无覆盖时不增加模型说明，不改变原有提示词内容。

## 0.2.31 (local, unpublished)

- 工具列表以实际工具标识为主标题，字号更大并加粗；中文仅作次要用途说明，不另起工具名。
- 待保存摘要直接列实际工具名，避免把中文用途当成名称；工具定义、执行和保存逻辑不变。

## 0.2.30 (local, unpublished)

- 删除运行偏好、工具方案及模板页的常驻解释性/教学式段落和对应中英文文案；作用范围、生效时间只保留简短标签，停用状态去掉说教说明，不留隐藏节点或占位。
- 设置控件、保存行为和所有后端逻辑保持不变。

## 0.2.29 (local, unpublished)

- 实际删除诊断入口、页面、模式、回调、状态、旧规则修复/原始名单编辑控件、专用样式及双语文案；不是隐藏入口或换名保留。
- 保留普通工具配置、当前预设保存、独立草稿、正常输入/保存校验，以及后台旧规则解析；不清除、不迁移、不重置用户旧数据。
- 仅调整客户端，不修改工具执行、权限、后端策略、提示词作用域或预设定义。

## 0.2.28 (local, unpublished)

- 设置页拆为“工具方案”和“运行偏好”，按实际工具分组、展示人类标签和变更摘要；逐工具选择保留，普通页不再出现全局工具总闸或兼容字段。
- 工具方案只保存当前预设，切换保留独立草稿，自己的成功提交仅在基线可证明未变时更新其它草稿版本；外部并发冲突拒绝并保稿。
- 旧规则、共享 Codex 模板和原始预设定义移入高级诊断，定义跟随当前预设只读；插件详情只作摘要，不再复制完整编辑器。
- 以 Agent 快照内的预设策略统一 Codex 工具准入，明确选择不再被旧共享开关二次否决；旧关闭作为兼容基线保留，原预设局部禁用及宿主权限不可越过，不写入或重置 profile 旧数据。
- 不新增 PTC、Ops 或执行工具，不改底层 shell、文件、审批和沙箱执行管线。

## 0.2.27 (local, unpublished)

- 按所选 preset 读取实际注册工具，逐项选择保留、隐藏或已实现的替代方案；去掉执行/计划总开关，支持搜索和筛选。
- 新增逐工具 `tools` 规则：明确选择优先于本规则的旧 allow/deny 与大类默认；旧配置不迁移，新界面新规则不联动其它工具。
- 工具目录通过预设 revision lease 与只读子作用域读取，不创建 Agent、不执行工具或激活条件；条件工具、目标名冲突和未适配工具不开放替换。
- 保留原有审批、单次沙箱策略、Agent 快照及双 owner 清理，补充独立源工具、目录隔离与回收、真实 Remote 保存回归。

## 0.2.26 (local, unpublished)

- 将设置页改为按 preset 切换的单编辑器：启用覆盖、执行/计划接口、保存；不再展开所有规则或重复显示 ID 输入。
- 精简常驻说明，工具裁剪、全局选项、提示词和源码按需展开；统一卡片、控件、间距与公开主题 token。
- 保留跨 preset 草稿、首次编辑 revision、空 allowlist 与未知 preset；不修改后端 schema 或迁移已有配置。

## 0.2.25 (local, unpublished)

- 在“设置 → 内置插件”中增加与 Codex Connect 并列的 Codex Harness 独立标签，工具规则置顶，预设声明作为折叠的只读参考。
- 工具规则可从现有预设目录选择真实 ID，保留自定义 ID 手动输入；目录失败可重试，不轮询、不妨碍现有规则编辑。
- 新标签与原插件详情页共用 ConfigForms、保存队列、配置命名空间和 revision 检查；不迁移或重置已保存设置，不改变 Codex Connect。
- 不修改 Host 工具覆盖、审批、文件工具或 Agent 规则快照语义；插件列表继续如实显示内部组件的运行诊断。

## 0.2.24 (local, unpublished)

- 新增独立的跨预设工具覆盖插件：在 Agent 子作用域按 preset ID 应用 allow/deny，并替换已有的原生执行与计划工具；保留 Persona、源预设和原生文件定义。
- 新增插件详情页规则编辑卡：显式空 allowlist、首编辑 revision 保存、并发拒绝留草稿、volatile 更新及新 Agent 规则快照。
- 限制替换范围，明确拒绝 conditional source、Agent 自身工具、未知名单和目标名称碰撞；支持空白会话预设切换及双 owner 清理。
- 补齐执行工具的宿主审批参数、单次升级策略、沙箱拒绝/runner 失败标记；不再吞掉 ShellExecution.result() 的基础设施错误。
- 当前宿主不再广告逐次 shell/login 参数；补充真实 Responses parser → Native 执行器 → 官方文件工具的成功、失败与结果回放测试。
- 新增可复现工具 schema/reference tokenizer、筛选、组装、调度与新 Agent 覆盖成本基准；不把离线微基准等同于模型端到端提速。

## 0.2.23 (local, unpublished)

- 适配当前 DeepSeek Harness `0.2.2-rc.1`，更新并锁定 Cordis、Host 与 Client 开发依赖；不再声明未经本轮验证的旧宿主版本兼容性。
- 将 Codex 模式改为普通 `dsh-agent-preset` bundle 声明，构建时生成 patch；使用当前工作流和子代理配置，不再自动修改旧预设目录。
- 适配异步 `shell.execute`、基于 SessionId 的后台任务输出、实时工作目录和 `fs.deleteFile`/删除意图检查。
- 通过工具注册条件应用能力开关，兼容不含 tools 的提示词 presentation；修复当前 tool/developer 消息的 Responses 转换和上下文压缩参数。
- 适配当前会话流记录及投影注册，避免在 Session publication 过程中嵌套写入上下文事件。
- 将设置页挂到 bundle 详情槽位，移除退役 Client API 依赖；保存时传递初次编辑 revision，拒绝覆盖并发修改。
- 补充当前 Loader、预设注册表、工具执行器和 Client ConfigForms 的 keyless 集成测试，以及中英文显示元数据和原创图标。

## 0.2.22 (local, unpublished)

- 兼容桌面端 `0.2.0-rc.2` 的原生预设注册、ConfigForms 设置和插件页面，保留 Web `0.1.5-rc.2` 接口。
- 将桌面 Codex 提示词、Fast、上下文容量和能力开关接入 profile 持久化配置；原生只读预设可查看，不能误写为文件预设。
- 适配新版 Persona 前缀及工作流执行器，避免在隔离的预设内重复注册宿主编辑服务。
- 修复终端等待定时器与中止监听器残留、清理后台进程时丢失已产生输出的问题。
- 修复预设列表刷新失败后的重试目标，并保护未保存的编辑。

## 0.2.20 - 2026-09-21

- 将 DSH 宿主声明限定为已验证的精确版本 `0.1.5-rc.2`，不再把未测试的更高版本标为兼容。

## 0.2.19 - 2026-09-21

- 在插件清单中声明最低 DSH 宿主版本 `>=0.1.5-rc.2`，让市场能够直接显示宿主要求并参与兼容性检查。
- 更新市场截图，改为当前的预设管理和 Codex 能力编辑界面。

## 0.2.18 - 2026-09-20

- 修复从没有 DSH Core 提示词的完整 Persona 创建 Codex 副本时，保存后自动补出源码和 Web 说明的问题。
- 保存时保留源预设的空提示词状态，避免预设编辑器把宿主默认段误显示为当前预设内容。

## 0.2.17 - 2026-09-20

- 简化为单页预设编辑：选择预设、修改名称和说明、按需加入 Codex、保存或另存副本。
- 移除列表中的逐项 YAML 读取与保存后的全量刷新；只在选择预设时加载内容，避免反复扫描目录。

- 支持普通预设的元数据和 Codex 能力转换，保存时检查版本冲突并保留备份，写入失败时回滚。
- 修复预设专用提示词被共享设置覆盖的问题，使用明确的 `presetPrompt` 优先级。
- 将托管网络搜索和远程上下文压缩归入 Codex 模式能力，活动状态保留为全局显示设置。

- 复制保留工具、插件、YAML 标签和其他配置；内置预设只读，用户预设通过锁定和原子写入保存。
- 修正设置卡片的宿主命名空间挂载：预设管理现在显示在 **插件配置 → Codex Harness** 卡片内，而不是注册到未提供的独立命名空间。
- 修正 Story 预设对宿主提示词区段的识别，避免把被 `clean-slate` 清除的 DSH Core 区段显示为可编辑内容。
- 让 Story 自动 Git 同步在无法获得一次性沙箱审批时降级为提示，不再阻断预设加载。

## 0.2.16 - 2026-09-20

- 发布统一层级的预设编辑器：Codex 模式与其它预设同级，内置预设通过副本编辑。
- 将 Codex 能力与全局活动状态分开，预设编辑器不再要求直接编辑 YAML。

## 0.2.15 - 2026-09-19

- 修复 Codex 预设与新版 `@deepseek-ai/dsh-persona` 的配置字段兼容性，使用 `prefix`。
- 自动迁移未修改过的旧 `text` 预设，并保留用户已经修改的预设。
- 记录最低宿主约束：`@deepseek-ai/dsh-persona >=0.1.3-alpha.2`。
- 补充旧预设迁移和用户修改保护的安装器回归测试。
- 固定 Corepack 使用的 pnpm 版本，并锁定兼容的本地压缩工具依赖，保证安装和发布流程可重复。
- 修正当前 DSH 客户端 overlay slot 的类型声明。

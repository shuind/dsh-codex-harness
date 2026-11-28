/** Locale dictionaries, tool grouping, human labels, and DSH-native styles for `ToolPolicySettingsCard`. */
import type { PresetToolEntry } from '../contracts/tool-policy-contract.ts'

export const toolPolicyEn = {
  settingsTabLabel: 'Codex Harness',
  settingsToolsPage: 'Preset plans',
  settingsRuntimePage: 'Runtime preferences',
  settingsSubTools: 'Tools',
  settingsPresetPrompts: 'Prompts',
  settingsDefinition: 'YAML',
  settingsPreferHostedSearch: 'Prefer model-hosted search',
  settingsPreferRemoteCompaction: 'Prefer remote compaction',
  settingsSharedFailed: 'Not saved; this page’s draft is kept. Shared settings may have changed—discard this page’s draft to reload.',
  settingsRuntimeScope: 'Shared in this environment',
  settingsSaveRuntime: 'Save runtime preferences',
  settingsBundleSummary: 'Configure Codex Harness in its dedicated Settings tab.',
  settingsBundlePath: 'Settings → Plugins → Codex Harness',
  settingsDefinitionAbsent: 'Choose a preset on Preset plans first.',
  globalGroupRequest: 'Model requests',
  globalGroupDisplay: 'Display',
  globalPending: 'Unsaved',
  toolPolicyTitle: 'Tool plan',
  toolPolicyPresetChoice: 'Preset',
  toolPolicyInvalidEntry: 'Empty preset ID',
  toolPolicyTiming: 'Applies to new or reloaded sessions',
  presetPromptsLoading: 'Loading prompts…',
  presetPromptsFailed: 'Prompts unavailable.',
  presetPromptsEmpty: 'No prompt sections.',
  presetPromptsReload: 'Reload prompts',
  presetPromptRestore: 'Restore original',
  presetPromptReadOnly: 'Read-only',
  presetPromptOverride: 'Override',
  presetSummaryTools: 'Tools',
  presetSummaryPrompts: 'Prompts',
  toolPolicyDraftSummary: 'Pending changes',
  toolPolicyRuleChanged: 'Preset changes',
  toolPolicyNoToolDelta: 'No pending changes',
  toolPolicySearch: 'Search tools',
  toolPolicyFilter: 'Tool filter',
  toolPolicyAll: 'All',
  toolPolicyModified: 'Customized',
  toolPolicyDeferredFilter: 'Deferred',
  toolPolicyReplaceable: 'Replaceable',
  toolPolicyDefaultDeferred: 'Default deferred',
  toolPolicyAction: 'Tool action',
  toolPolicyKeep: 'Enable',
  toolPolicyDefer: 'Defer',
  toolPolicyDeferHint: 'Defer loading until activated via activate_tools',
  toolPolicyHide: 'Hide',
  toolPolicyReplaceShort: 'Replace',
  toolPolicyRestoreChoice: 'Restore default choice',
  toolPolicyUnsupported: 'Saved replacement unavailable',
  toolPolicyConditional: 'Conditional',
  toolPolicyTargetExists: 'Replacement target already exists',
  toolPolicyPresetDisabled: 'Disabled by original preset',
  toolPolicyGptGroup: 'GPT capabilities',
  toolPolicyGptHostedSearch: 'GPT hosted search',
  toolPolicyGptHostedSearchTitle: 'GPT sessions prefer OpenAI Responses hosted web_search (controlled in Runtime preferences).',
  toolPolicyGptCodexSearch: 'Codex search',
  toolPolicyGptCodexSearchTitle: 'Profile-wide web search owned by Codex Connect.',
  toolPolicyGptDualSearch: 'GPT hosted / Codex search',
  toolPolicyGptDualSearchTitle: 'GPT sessions prefer OpenAI hosted web_search; other models use Codex Connect search.',
  toolPolicyGptImageTitle: 'Provided by Codex Connect (ChatGPT subscription image endpoint; tested to route to GPT-Image-2.6 Sunburst); callable from any tool-capable model.',
  toolPolicyGptCompactionDesc: 'Server-side native context compaction (GPT sessions only; falls back to local summary on failure)',
  toolPolicyGptCompactionBadge: 'GPT native compaction',
  toolPolicyGptCompactionReadOnly: 'Non-tool · Runtime preference',
  toolPolicyCommandGroup: 'Commands & runtime',
  toolPolicyFileGroup: 'Files & search',
  toolPolicyPlanGroup: 'Planning & interaction',
  toolPolicyCollabGroup: 'Agents & workflows',
  toolPolicyOtherGroup: 'Web & extensions',
  toolPolicyCustomized: 'customized',
  toolLabelExec: 'Run terminal command in Shell / PTY', toolLabelStdin: 'Poll output or send stdin to interactive PTY',
  toolLabelPwsh: 'Run PowerShell command', toolLabelBash: 'Run Bash command',
  toolLabelRunCode: 'Run SDK code in sandbox to batch tool calls', toolLabelJobList: 'List running and finished background jobs',
  toolLabelJobOutput: 'Read incremental output or result of a background job', toolLabelJobKill: 'Stop a running background job',
  toolLabelTermOpen: 'Open a persistent terminal session', toolLabelTermList: 'List persistent terminal sessions',
  toolLabelTermRead: 'Read output from a persistent terminal', toolLabelTermSend: 'Send input to a persistent terminal',
  toolLabelTermSignal: 'Send signal to a persistent terminal', toolLabelTermClose: 'Close a persistent terminal session',
  toolLabelWorkdir: 'Read or change working directory (cd)', toolLabelWorktree: 'Create Git branch and worktree',
  toolLabelPatch: 'Create, edit, delete, or move files via Codex patch', toolLabelRead: 'Read UTF-8 text file with line numbers',
  toolLabelWrite: 'Create or overwrite UTF-8 text file', toolLabelEdit: 'Edit file by replacing literal text',
  toolLabelStrReplace: 'View or edit files via str_replace commands', toolLabelGlob: 'Find file paths by glob pattern',
  toolLabelGrep: 'Search file contents with ripgrep regex', toolLabelImage: 'Read PNG/JPEG/WebP/GIF image',
  toolLabelLsp: 'Query LSP for definitions, references, and symbols', toolLabelPlan: 'Update execution plan and step statuses',
  toolLabelTodo: 'Write complete todo list', toolLabelExitPlan: 'Submit Markdown plan to exit plan mode',
  toolLabelAskUser: 'Ask structured questions to the user', toolLabelPresent: 'Present deliverable files to the user',
  toolLabelProposeAction: 'Propose action card for user approval', toolLabelApprove: 'Approve action denied by Codex Auto-review',
  toolLabelSubagent: 'Spawn isolated subagent for a subtask', toolLabelSubagentFork: 'Fork subagent from current context',
  toolLabelSubagentCodex: 'Delegate task to Codex subagent', toolLabelSubagentClaude: 'Delegate task to Claude Code subagent',
  toolLabelSubagentOar: 'Run experimental OAR subagent', toolLabelSubagentModels: 'List available models for subagents',
  toolLabelSendMessage: 'Send message to subagent or teammate', toolLabelListAgents: 'List started subagents and statuses',
  toolLabelInterruptAgent: 'Interrupt a running subagent', toolLabelWaitAgent: 'Wait for subagent or teammate updates',
  toolLabelWorkflow: 'Run multi-stage or parallel PTC workflow', toolLabelRalph: 'Run iterative Ralph loop agent',
  toolLabelCreateGoal: 'Create persistent session goal', toolLabelGetGoal: 'Read current session goal',
  toolLabelUpdateGoal: 'Update current session goal', toolLabelGoal: 'Manage current session goal',
  toolLabelSpawnTeammate: 'Spawn durable Team teammate', toolLabelTeamCreate: 'Create task on shared Team board',
  toolLabelTeamGet: 'Read latest shared Team task state', toolLabelTeamList: 'List shared Team tasks and blockers',
  toolLabelTeamUpdate: 'Update shared Team task with revision check', toolLabelWebSearch: 'Search the web for current information',
  toolLabelWebFetch: 'Fetch decoded text from HTTP(S) URL', toolLabelSkill: 'Load full instructions for a skill',
  toolLabelActivateTools: 'Activate deferred (deferLoading) tools', toolLabelSchedule: 'Manage scheduled tasks',
  toolLabelScheduleCreate: 'Create one-shot or cron schedule', toolLabelScheduleEdit: 'Edit or toggle an existing schedule',
  toolLabelScheduleList: 'List configured schedules', toolLabelScheduleView: 'View schedule details and history',
  toolLabelPluginManager: 'Manage plugins in current profile', toolLabelPluginMarket: 'Browse plugin market indexes',
  toolLabelCordisList: 'List Cordis Inspect Providers', toolLabelCordisQuery: 'Run read-only Cordis Inspect query',
  toolLabelSessionSearch: 'Search events across prior sessions', toolLabelSessionTrace: 'Trace session lineage',
  toolLabelSessionEventRead: 'Read full raw event from session', toolLabelSessionEventSearch: 'Search events within a session',
  toolLabelSessionEventTrace: 'Trace event replacements and citations', toolLabelMcpList: 'List resources from MCP server',
  toolLabelMcpTemplates: 'List URI templates from MCP server', toolLabelMcpRead: 'Read MCP server resource by URI',
  toolLabelWorkspaceDeps: 'Get bundled Python and library paths', toolLabelStagehandNav: 'Navigate browser to URL (Stagehand)',
  toolLabelStagehandAct: 'Perform page interaction (Stagehand)', toolLabelStagehandExtract: 'Extract structured page data (Stagehand)',
  toolLabelStagehandObserve: 'Observe interactive page elements (Stagehand)', toolLabelStagehandShot: 'Capture browser screenshot (Stagehand)',
  toolLabelStagehandTabs: 'Manage browser tabs (Stagehand)',
  toolLabelViewImage: 'View local or HTTP(S) image (Codex Connect)',
  toolLabelCodexImageGen: 'Generate or edit images via GPT Image (Codex Connect)',
  toolLabelCodexQuota: 'Query shared Codex account quota (Codex Connect)',
  toolLabelMcpDynamic: 'MCP server tool', toolLabelOther: 'Other tool',
  toolPolicyToolsLoading: 'Loading tools…',
  toolPolicyToolsEmpty: 'No registered tools.',
  toolPolicyNoMatches: 'No matching tools.',
  toolPolicyToolsFailed: 'Tool list unavailable. Saved rules are kept.',
  toolPolicyToolsRefresh: 'Refresh tools',
  toolPolicyCatalogLoading: 'Loading presets…',
  toolPolicyCatalogEmpty: 'No presets found.',
  toolPolicyCatalogFailed: 'Preset list unavailable. Saved IDs remain selectable.',
  toolPolicyCatalogRetry: 'Reload presets',
  toolPolicyEmpty: 'Choose a preset',
  toolPolicySave: 'Save preset',
  toolPolicySaving: 'Saving…',
  toolPolicyDiscard: 'Discard draft',
  toolPolicySaved: 'Preset saved.',
  toolPolicyInvalidPreset: 'An empty preset ID cannot be saved.',
  toolPolicyDuplicatePreset: 'Duplicate preset IDs cannot be saved.',
  toolPolicyRefused: 'Not saved. Draft started from older settings; discard draft to reload.',
  toolPolicyFailed: 'Save failed. Draft is kept.',
  toolPolicyReadOnly: 'These settings are read-only.',
  pmRefresh: 'Refresh',
  peLoading: 'Loading preset…',
  peReadError: 'Preset definition unavailable.',
} as const

export const toolPolicyZh: Record<keyof typeof toolPolicyEn, string> = {
  settingsTabLabel: 'Codex Harness',
  settingsToolsPage: '预设方案',
  settingsRuntimePage: '运行偏好',
  settingsSubTools: '工具',
  settingsPresetPrompts: '提示词',
  settingsDefinition: '原始定义',
  settingsPreferHostedSearch: '优先使用模型托管搜索',
  settingsPreferRemoteCompaction: '优先使用远程压缩',
  settingsSharedFailed: '未保存，本页草稿已保留。共享设置可能已更新，请放弃本页草稿后重新读取。',
  settingsRuntimeScope: '本环境共享',
  settingsSaveRuntime: '保存运行偏好',
  settingsBundleSummary: '请在独立的 Codex Harness 设置页配置。',
  settingsBundlePath: '设置 → 内置插件 → Codex Harness',
  settingsDefinitionAbsent: '请先在预设方案页选择预设。',
  globalGroupRequest: '模型请求',
  globalGroupDisplay: '界面',
  globalPending: '未保存',
  toolPolicyTitle: '工具方案',
  toolPolicyPresetChoice: '预设',
  toolPolicyInvalidEntry: '空预设 ID',
  toolPolicyTiming: '新建或重载会话后生效',
  presetPromptsLoading: '正在读取提示词…',
  presetPromptsFailed: '提示词暂不可用。',
  presetPromptsEmpty: '没有提示词段落。',
  presetPromptsReload: '重新读取提示词',
  presetPromptRestore: '恢复原始',
  presetPromptReadOnly: '只读',
  presetPromptOverride: '覆盖',
  presetSummaryTools: '工具',
  presetSummaryPrompts: '提示词',
  toolPolicyDraftSummary: '本次修改',
  toolPolicyRuleChanged: '预设方案调整',
  toolPolicyNoToolDelta: '没有待保存变化',
  toolPolicySearch: '搜索工具',
  toolPolicyFilter: '工具筛选',
  toolPolicyAll: '全部',
  toolPolicyModified: '已修改',
  toolPolicyDeferredFilter: '按需延迟',
  toolPolicyReplaceable: '可替换',
  toolPolicyDefaultDeferred: '默认延迟',
  toolPolicyAction: '工具操作',
  toolPolicyKeep: '启用',
  toolPolicyDefer: '延迟',
  toolPolicyDeferHint: '按需延迟加载（通过 activate_tools 激活）',
  toolPolicyHide: '隐藏',
  toolPolicyReplaceShort: '替换',
  toolPolicyRestoreChoice: '恢复默认选择',
  toolPolicyUnsupported: '已保存的替换当前不可用',
  toolPolicyConditional: '按条件可用',
  toolPolicyTargetExists: '替换目标已存在',
  toolPolicyPresetDisabled: '原预设未启用',
  toolPolicyGptGroup: 'GPT 能力',
  toolPolicyGptHostedSearch: 'GPT 托管搜索',
  toolPolicyGptHostedSearchTitle: 'GPT 会话优先使用 OpenAI Responses 原生托管搜索（由「运行偏好」控制）。',
  toolPolicyGptCodexSearch: 'Codex 订阅搜索',
  toolPolicyGptCodexSearchTitle: '由 Codex Connect 接管当前配置全局联网搜索。',
  toolPolicyGptDualSearch: 'GPT 托管 / Codex 搜索',
  toolPolicyGptDualSearchTitle: 'GPT 会话优先使用 OpenAI 原生托管搜索；其他模型走 Codex Connect 订阅搜索。',
  toolPolicyGptImageTitle: '来源于 Codex Connect（ChatGPT 订阅生图接口，实测路由至 GPT-Image-2.6 Sunburst），支持工具调用的模型均可调用。',
  toolPolicyGptCompactionDesc: '使用 OpenAI 服务端原生压缩替代默认文本摘要（仅 GPT 会话，失败自动回退）',
  toolPolicyGptCompactionBadge: 'GPT 原生压缩',
  toolPolicyGptCompactionReadOnly: '非工具 · 运行偏好控制',
  toolPolicyCommandGroup: '命令与执行',
  toolPolicyFileGroup: '文件与检索',
  toolPolicyPlanGroup: '规划与交互',
  toolPolicyCollabGroup: '子代理与工作流',
  toolPolicyOtherGroup: '网络与扩展',
  toolPolicyCustomized: '项修改',
  toolLabelExec: '在 Shell / PTY 中运行终端命令', toolLabelStdin: '轮询命令输出或向交互式 PTY 发送输入',
  toolLabelPwsh: '执行 PowerShell 命令', toolLabelBash: '执行 Bash 命令',
  toolLabelRunCode: '在沙箱中运行 SDK 代码批量调用工具', toolLabelJobList: '列出后台 job（运行中与已结束）及状态',
  toolLabelJobOutput: '读取后台 job 的增量输出或结果', toolLabelJobKill: '终止正在运行的后台 job',
  toolLabelTermOpen: '创建持久化终端 session', toolLabelTermList: '列出当前 Agent 的持久化终端 session',
  toolLabelTermRead: '分页读取持久化终端输出', toolLabelTermSend: '向持久化终端发送输入',
  toolLabelTermSignal: '向持久化终端进程组发送信号', toolLabelTermClose: '关闭持久化终端并清理进程树',
  toolLabelWorkdir: '查看或切换当前工作目录（cd）', toolLabelWorktree: '新建 Git 分支与 Worktree 并切换目录',
  toolLabelPatch: '使用 Codex Patch 语法增删改移文件', toolLabelRead: '读取 UTF-8 文本文件（带行号）',
  toolLabelWrite: '新建或覆盖写入 UTF-8 文本文件', toolLabelEdit: '按字面文本精确替换修改文件',
  toolLabelStrReplace: '使用 str_replace 命令查看或编辑文件', toolLabelGlob: '按 Glob 模式匹配查找文件路径',
  toolLabelGrep: '使用 ripgrep 正则搜索文件内容', toolLabelImage: '读取 PNG / JPEG / WebP / GIF 图片',
  toolLabelLsp: '通过 LSP 查询定义跳转、引用与符号', toolLabelPlan: '更新任务执行计划与步骤状态',
  toolLabelTodo: '覆盖写入待办任务列表（todo）', toolLabelExitPlan: '提交 Markdown 方案并请求退出 Plan 模式',
  toolLabelAskUser: '向用户发起结构化提问', toolLabelPresent: '将文件声明为交付物展示给用户',
  toolLabelProposeAction: '发起需用户确认的操作卡片', toolLabelApprove: '批准被 Codex Auto-review 拦截的操作',
  toolLabelSubagent: '启动独立上下文的 subagent 执行子任务', toolLabelSubagentFork: '基于当前上下文 fork 子代理',
  toolLabelSubagentCodex: '委托外部 Codex subagent 执行任务', toolLabelSubagentClaude: '委托外部 Claude Code subagent 执行任务',
  toolLabelSubagentOar: '启动实验性 OAR subagent', toolLabelSubagentModels: '查询可用于 subagent 的模型列表',
  toolLabelSendMessage: '向 subagent 或协作代理发送消息', toolLabelListAgents: '列出已启动的 subagent 及状态',
  toolLabelInterruptAgent: '中断指定 subagent 当前任务', toolLabelWaitAgent: '等待 subagent 或团队成员状态更新',
  toolLabelWorkflow: '运行多阶段 / 并行 PTC 工作流', toolLabelRalph: '运行多轮自动迭代的 Ralph 循环代理',
  toolLabelCreateGoal: '创建持久化会话 Goal', toolLabelGetGoal: '读取当前会话 Goal 状态',
  toolLabelUpdateGoal: '更新当前会话 Goal 进度', toolLabelGoal: '管理当前会话 Goal',
  toolLabelSpawnTeammate: '创建持久化 Team 协作代理', toolLabelTeamCreate: '在 Team 看板新建待认领任务',
  toolLabelTeamGet: '读取 Team 共享任务最新状态', toolLabelTeamList: '列出 Team 共享任务与阻塞关系',
  toolLabelTeamUpdate: '按修订号更新 Team 共享任务', toolLabelWebSearch: '搜索实时网页信息与来源摘要',
  toolLabelWebFetch: '抓取指定 HTTP(S) URL 网页文本', toolLabelSkill: '按需加载指定 Skill 完整指令',
  toolLabelActivateTools: '激活按需延迟加载（deferLoading）的工具', toolLabelSchedule: '管理定时与周期任务',
  toolLabelScheduleCreate: '新建一次性或 Cron 周期任务', toolLabelScheduleEdit: '修改或启停已有定时任务',
  toolLabelScheduleList: '列出定时任务与下次触发时间', toolLabelScheduleView: '查看单个定时任务详情与记录',
  toolLabelPluginManager: '查看、启停、安装或移除 Profile 插件', toolLabelPluginMarket: '浏览插件市场索引与可安装包',
  toolLabelCordisList: '列出宿主已知的 Cordis Inspect Provider', toolLabelCordisQuery: '执行 Cordis Inspect 只读诊断查询',
  toolLabelSessionSearch: '跨历史 Session 搜索匹配事件', toolLabelSessionTrace: '追踪 Session 派生与上下文链路',
  toolLabelSessionEventRead: '读取 Session 单条完整原始事件', toolLabelSessionEventSearch: '在单个 Session 内搜索历史事件',
  toolLabelSessionEventTrace: '追踪单条 Session 事件的引用与替换链', toolLabelMcpList: '列出 MCP Server 可用资源',
  toolLabelMcpTemplates: '列出 MCP Server 参数化 URI 模板', toolLabelMcpRead: '按 URI 读取 MCP Server 资源内容',
  toolLabelWorkspaceDeps: '获取内置 Python 与依赖库路径', toolLabelStagehandNav: '浏览器导航至目标 URL（Stagehand）',
  toolLabelStagehandAct: '在页面执行交互操作（Stagehand）', toolLabelStagehandExtract: '从页面提取结构化数据（Stagehand）',
  toolLabelStagehandObserve: '观察页面可交互元素（Stagehand）', toolLabelStagehandShot: '截取当前浏览器页面（Stagehand）',
  toolLabelStagehandTabs: '管理浏览器标签页（Stagehand）',
  toolLabelViewImage: '查看本地或 HTTP(S) 图片（Codex Connect）',
  toolLabelCodexImageGen: '通过 GPT Image 生成或编辑图片（Codex Connect）',
  toolLabelCodexQuota: '查询当前 Codex 账号共享额度（Codex Connect）',
  toolLabelMcpDynamic: 'MCP 扩展工具', toolLabelOther: '其它工具',
  toolPolicyToolsLoading: '正在读取工具…',
  toolPolicyToolsEmpty: '没有已注册工具。',
  toolPolicyNoMatches: '没有匹配工具。',
  toolPolicyToolsFailed: '工具目录不可用，已保存规则仍保留。',
  toolPolicyToolsRefresh: '刷新工具',
  toolPolicyCatalogLoading: '正在读取预设…',
  toolPolicyCatalogEmpty: '没有可选预设。',
  toolPolicyCatalogFailed: '预设列表不可用，仍可选择已保存 ID。',
  toolPolicyCatalogRetry: '重新读取预设',
  toolPolicyEmpty: '请选择预设',
  toolPolicySave: '保存此预设',
  toolPolicySaving: '正在保存…',
  toolPolicyDiscard: '放弃草稿',
  toolPolicySaved: '此预设已保存。',
  toolPolicyInvalidPreset: '预设 ID 为空，无法保存。',
  toolPolicyDuplicatePreset: '预设 ID 重复，无法保存。',
  toolPolicyRefused: '未保存，草稿基于旧设置。请放弃草稿后重新读取。',
  toolPolicyFailed: '保存失败，此预设草稿已保留。',
  toolPolicyReadOnly: '当前设置为只读。',
  pmRefresh: '刷新',
  peLoading: '正在读取预设…',
  peReadError: '预设定义暂不可用。',
}

const commandNames = new Set([
  'bash', 'pwsh', 'exec_command', 'write_stdin', 'run_code', 'job_list', 'job_output', 'job_kill',
  'terminal_open', 'terminal_list', 'terminal_read', 'terminal_send', 'terminal_signal', 'terminal_close',
  'working_directory', 'create_worktree',
])
const fileNames = new Set(['read', 'write', 'edit', 'str_replace_editor', 'apply_patch', 'glob', 'grep', 'read_image', 'view_image', 'lsp'])
const planNames = new Set(['todo_write', 'update_plan', 'exit_plan_mode', 'ask_user_question', 'present', 'propose_action', 'approve'])
const collabNames = new Set([
  'subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'subagent_oar', 'list_subagent_models',
  'send_message', 'list_agents', 'interrupt_agent', 'wait_agent', 'workflow', 'ralph',
  'create_goal', 'get_goal', 'update_goal', 'goal', 'spawn_teammate', 'team_task_create', 'team_task_get',
  'team_task_list', 'team_task_update',
])

export type ToolGroupId = 'gpt' | 'command' | 'file' | 'plan' | 'collab' | 'other'

export function groupOf(tool: PresetToolEntry, gptSearchActive = false): ToolGroupId {
  if (tool.name === 'codex_connect_image_generate') return 'gpt'
  if (tool.name === 'web_search' && gptSearchActive) return 'gpt'
  if (commandNames.has(tool.name) || tool.replacements.some(item => item.action === 'codex-exec')) return 'command'
  if (fileNames.has(tool.name) || tool.replacements.some(item => item.action === 'codex-patch')) return 'file'
  if (planNames.has(tool.name) || tool.replacements.some(item => item.action === 'codex-plan')) return 'plan'
  if (collabNames.has(tool.name)) return 'collab'
  return 'other'
}

export const humanLabels = {
  exec_command: 'toolLabelExec', write_stdin: 'toolLabelStdin', pwsh: 'toolLabelPwsh', bash: 'toolLabelBash',
  run_code: 'toolLabelRunCode', job_list: 'toolLabelJobList', job_output: 'toolLabelJobOutput', job_kill: 'toolLabelJobKill',
  terminal_open: 'toolLabelTermOpen', terminal_list: 'toolLabelTermList', terminal_read: 'toolLabelTermRead',
  terminal_send: 'toolLabelTermSend', terminal_signal: 'toolLabelTermSignal', terminal_close: 'toolLabelTermClose',
  working_directory: 'toolLabelWorkdir', create_worktree: 'toolLabelWorktree', apply_patch: 'toolLabelPatch',
  read: 'toolLabelRead', write: 'toolLabelWrite', edit: 'toolLabelEdit', str_replace_editor: 'toolLabelStrReplace',
  glob: 'toolLabelGlob', grep: 'toolLabelGrep', read_image: 'toolLabelImage', lsp: 'toolLabelLsp',
  update_plan: 'toolLabelPlan', todo_write: 'toolLabelTodo', exit_plan_mode: 'toolLabelExitPlan',
  ask_user_question: 'toolLabelAskUser', present: 'toolLabelPresent', propose_action: 'toolLabelProposeAction', approve: 'toolLabelApprove',
  subagent: 'toolLabelSubagent', subagent_fork: 'toolLabelSubagentFork', subagent_codex: 'toolLabelSubagentCodex',
  subagent_claude_code: 'toolLabelSubagentClaude', subagent_oar: 'toolLabelSubagentOar', list_subagent_models: 'toolLabelSubagentModels',
  send_message: 'toolLabelSendMessage', list_agents: 'toolLabelListAgents', interrupt_agent: 'toolLabelInterruptAgent',
  wait_agent: 'toolLabelWaitAgent', workflow: 'toolLabelWorkflow', ralph: 'toolLabelRalph',
  create_goal: 'toolLabelCreateGoal', get_goal: 'toolLabelGetGoal', update_goal: 'toolLabelUpdateGoal', goal: 'toolLabelGoal',
  spawn_teammate: 'toolLabelSpawnTeammate', team_task_create: 'toolLabelTeamCreate', team_task_get: 'toolLabelTeamGet',
  team_task_list: 'toolLabelTeamList', team_task_update: 'toolLabelTeamUpdate', web_search: 'toolLabelWebSearch',
  web_fetch: 'toolLabelWebFetch', skill: 'toolLabelSkill', activate_tools: 'toolLabelActivateTools',
  schedule: 'toolLabelSchedule', schedule_create: 'toolLabelScheduleCreate', schedule_edit: 'toolLabelScheduleEdit',
  schedule_list: 'toolLabelScheduleList', schedule_view: 'toolLabelScheduleView',
  plugin_manager: 'toolLabelPluginManager', plugin_market: 'toolLabelPluginMarket',
  cordis_inspect_list: 'toolLabelCordisList', cordis_inspect_query: 'toolLabelCordisQuery',
  session_search: 'toolLabelSessionSearch', session_trace: 'toolLabelSessionTrace',
  session_event_read: 'toolLabelSessionEventRead', session_event_search: 'toolLabelSessionEventSearch',
  session_event_trace: 'toolLabelSessionEventTrace', list_mcp_resources: 'toolLabelMcpList',
  list_mcp_resource_templates: 'toolLabelMcpTemplates', read_mcp_resource: 'toolLabelMcpRead',
  load_workspace_dependencies: 'toolLabelWorkspaceDeps', stagehand_navigate: 'toolLabelStagehandNav',
  stagehand_act: 'toolLabelStagehandAct', stagehand_extract: 'toolLabelStagehandExtract',
  stagehand_observe: 'toolLabelStagehandObserve', stagehand_screenshot: 'toolLabelStagehandShot',
  stagehand_tabs: 'toolLabelStagehandTabs',
  view_image: 'toolLabelViewImage',
  codex_connect_image_generate: 'toolLabelCodexImageGen',
  codex_connect_quota: 'toolLabelCodexQuota',
} as const

export const policyStyles = `
.codex-tool-policy { display:flex; flex-direction:column; gap:12px; min-width:0; font-size:13px; color:var(--dsw-alias-label-primary); }
.codex-tool-policy p, .codex-tool-policy h3, .codex-tool-policy h4 { margin:0; }
.codex-tool-policy .codex-tool-policy-note { color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size:12px; line-height:1.45; }
.codex-tool-policy form, .codex-tool-policy fieldset { min-width:0; margin:0; padding:0; border:0; display:flex; flex-direction:column; gap:10px; }
.codex-tool-policy .codex-card { border:0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); border-radius:var(--dsw-radius-xl, 12px); background:var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1)); padding:12px 14px; }
.codex-tool-policy .codex-preset-bar { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px; }
.codex-tool-policy .codex-preset-select-wrap { display:flex; align-items:center; gap:8px; min-width:0; flex:1 1 260px; }
.codex-tool-policy .codex-preset-select-wrap select { min-width:0; flex:1; height:32px; padding:0 10px; border:0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); border-radius:var(--dsw-radius-md, 8px); background:var(--dsw-alias-bg-layer-2); color:inherit; font:inherit; }
.codex-tool-policy .codex-btn { box-sizing:border-box; height:32px; padding:0 11px; border:0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); border-radius:var(--dsw-radius-md, 8px); background:var(--dsw-alias-bg-layer-2); color:inherit; font:inherit; font-size:12px; cursor:pointer; white-space:nowrap; }
.codex-tool-policy .codex-btn:disabled { opacity:.48; cursor:default; }
.codex-tool-policy .codex-btn-primary { background:var(--dsw-alias-label-primary); color:var(--dsw-alias-bg-base); border-color:transparent; font-weight:500; }
.codex-tool-policy .codex-seg { display:inline-flex; align-items:center; gap:2px; padding:2px; border-radius:var(--dsw-radius-md, 8px); background:var(--dsw-alias-bg-layer-2); border:0.5px solid var(--dsw-alias-border-l2); flex-shrink:0; }
.codex-tool-policy .codex-seg button { border:0; border-radius:6px; padding:4px 9px; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:12px; line-height:18px; cursor:pointer; white-space:nowrap; transition:background .12s, color .12s; }
.codex-tool-policy .codex-seg button:hover:not(:disabled) { color:var(--dsw-alias-label-primary); }
.codex-tool-policy .codex-seg button:disabled { opacity:.38; cursor:default; }
.codex-tool-policy .codex-seg button[aria-pressed=true] { background:var(--dsw-alias-label-primary); color:var(--dsw-alias-bg-base); font-weight:500; }
.codex-tool-policy .codex-seg button[data-action=defer][aria-pressed=true] { background:var(--dsw-alias-interactive-bg-selected, rgba(59,130,246,0.14)); color:var(--dsw-static-blue-500, var(--dsw-alias-brand-primary)); font-weight:600; }
.codex-tool-policy .codex-seg button[data-action=hide][aria-pressed=true] { background:var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); color:var(--dsw-alias-label-primary); }
.codex-tool-policy :is(input,select,button,summary,textarea):focus-visible { outline:2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset:2px; }
.codex-tool-policy .codex-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.codex-tool-policy .codex-toolbar input[type=text] { flex:1 1 180px; min-width:0; height:32px; padding:0 10px; border:0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); border-radius:var(--dsw-radius-md, 8px); background:var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-layer-2)); color:inherit; font:inherit; font-size:13px; }
.codex-tool-policy details.codex-group { border:0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); border-radius:var(--dsw-radius-xl, 12px); background:var(--dsw-alias-settings-card-fill, transparent); overflow:hidden; }
.codex-tool-policy details.codex-group > summary { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 14px; font-weight:600; font-size:13px; cursor:pointer; list-style:none; user-select:none; }
.codex-tool-policy details.codex-group[open] > summary { border-bottom:0.5px solid var(--dsw-alias-border-l1); }
.codex-tool-policy .codex-tool-policy-table { display:flex; flex-direction:column; }
.codex-tool-policy .codex-tool-policy-tool { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px 12px; padding:8px 14px; border-bottom:0.5px solid var(--dsw-alias-border-l1); }
.codex-tool-policy .codex-tool-policy-tool:last-child { border-bottom:0; }
.codex-tool-policy .codex-tool-policy-tool[data-tool-action=hide] .codex-tool-policy-name { opacity:.52; }
.codex-tool-policy .codex-tool-policy-name { min-width:0; flex:1 1 220px; display:flex; flex-wrap:wrap; align-items:center; gap:4px 8px; overflow-wrap:anywhere; }
.codex-tool-policy .codex-tool-policy-identifier { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); }
.codex-tool-policy .codex-tool-policy-description { font-size:12px; color:var(--dsw-alias-label-secondary); }
.codex-tool-policy .codex-badge { font-size:11px; line-height:16px; padding:1px 6px; border-radius:999px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); border:0.5px solid var(--dsw-alias-border-l2); }
.codex-tool-policy .codex-badge[data-tone=blue] { background:var(--dsw-alias-interactive-bg-selected, rgba(59,130,246,0.12)); color:var(--dsw-static-blue-500, var(--dsw-alias-brand-primary)); border-color:transparent; }
.codex-tool-policy .codex-badge[data-tone=gpt] { background:var(--dsw-alias-state-success-bg, rgba(16,163,127,0.12)); color:var(--dsw-alias-state-success-primary, #10a37f); border-color:transparent; font-weight:500; }
.codex-tool-policy .codex-badge[data-tone=warn] { color:var(--dsw-alias-state-warn-primary); }
.codex-tool-policy .codex-tool-policy-action { display:flex; align-items:center; gap:6px; flex-shrink:0; }
.codex-tool-policy .codex-tool-policy-prompts { display:flex; flex-direction:column; gap:10px; }
.codex-tool-policy .codex-tool-policy-prompt { display:grid; gap:8px; }
.codex-tool-policy textarea { box-sizing:border-box; width:100%; min-width:0; resize:vertical; padding:8px 10px; border:0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); border-radius:var(--dsw-radius-md, 8px); background:var(--dsw-alias-bg-layer-2); color:inherit; font:inherit; }
.codex-tool-policy .codex-tool-policy-prompt pre { margin:0; max-height:240px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; font-size:12px; }
.codex-tool-policy .codex-save-bar { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; padding:10px 14px; border:0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); border-radius:var(--dsw-radius-xl, 12px); background:var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1)); }
.codex-tool-policy .codex-save-bar[data-dirty=true] { position:sticky; bottom:8px; z-index:2; border-color:var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); background:var(--dsw-alias-bg-layer-1, var(--dsw-alias-settings-card-fill)); box-shadow:0 4px 16px rgba(0,0,0,0.12); }
.codex-tool-policy .codex-save-buttons { display:flex; align-items:center; gap:8px; }
.codex-tool-policy .codex-tool-policy-warning { color:var(--dsw-alias-state-warn-primary); font-size:12px; }
.codex-tool-policy .codex-tool-policy-error { color:var(--dsw-alias-state-error-primary); font-size:12px; }
`

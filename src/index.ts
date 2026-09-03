/** Codex-compatible prompt overlay and core tools for a dsh agent preset. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { FsInfo, FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-terminal'
import { APPLY_PATCH_DESCRIPTION, applyPatchHunks, parsePatch } from './patch.ts'
import type { PatchFile } from './patch.ts'
import { renderExecResult, runExecCommand, runWriteStdin } from './exec.ts'
import type { ExecCommandArgs, ExecResult, WriteStdinArgs } from './exec.ts'
import {
  hostedWebSearchStream,
  installHostedWebSearch,
  remoteCompactStream,
  repairLegacyPiAiContextOverflow,
} from './remote.ts'
import { registerCodexActivityProjection } from './activity.ts'
import {
  DEFAULT_CODEX_PERSONA,
  DEFAULT_CODEX_SYSTEM_PROMPT,
  DEFAULT_DSH_CORE_SOURCE_PROMPT,
  DEFAULT_DSH_CORE_WEB_PROMPT,
  resolveCodexSystemPrompt,
} from './prompt.ts'
import {
  CODEX_SETTINGS_ENTRY, CODEX_SETTINGS_NAMESPACE, CODEX_SETTINGS_SCHEMA,
} from './settings.ts'
import type { CodexSettings } from './settings.ts'
import { codexCompactionMode } from './compaction.ts'

export {
  DEFAULT_CODEX_PERSONA,
  DEFAULT_CODEX_SYSTEM_PROMPT,
  DEFAULT_DSH_CORE_SOURCE_PROMPT,
  DEFAULT_DSH_CORE_WEB_PROMPT,
} from './prompt.ts'
export { CODEX_SETTINGS_NAMESPACE, CODEX_SETTINGS_SCHEMA } from './settings.ts'
export type { CodexSettings } from './settings.ts'

export const name = 'codex'
export const inject = ['tools', 'systemPrompt', 'shell', 'fs', 'llm', 'credentials', 'settings']
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

/** Configuration for the Codex shell result bridge. */
export interface Config {
  /** Install request/transport/activity enhancements for every agent scope. */
  globalEnhancements?: boolean
  /** Install the Codex operating prompt and four core tools in this scope. */
  codexCore?: boolean
  /** Default wait before a pipe-backed command yields a session id. */
  defaultYieldTimeMs?: number
  /** Default wait for an empty `write_stdin` poll. */
  pollYieldTimeMs?: number
  /** Default wait for a non-empty `write_stdin` send. */
  writeYieldTimeMs?: number
  /** Maximum output retained in one canonical result, in UTF-8 bytes. */
  maxOutputBytes?: number
  /** Send GPT Responses requests with the native hosted web_search tool first. */
  hostedWebSearch?: boolean
  /** Use the provider's /responses/compact endpoint before local compaction. */
  remoteCompact?: boolean
  /** Complete plugin-owned Codex operating prompt. */
  systemPrompt?: string
  /** Deployment Persona template. */
  persona?: string
  /** DSH Core source-checkout guidance template. */
  harnessSourcePrompt?: string
  /** DSH Core Web GUI guidance template. */
  webSurfacePrompt?: string
}

/** Runtime configuration schema for the Codex tool bridge. */
export const Config: z<Config> = z.object({
  globalEnhancements: z.boolean().default(true),
  codexCore: z.boolean().default(true),
  defaultYieldTimeMs: z.number().step(1).min(0).default(10_000),
  pollYieldTimeMs: z.number().step(1).min(0).default(5_000),
  writeYieldTimeMs: z.number().step(1).min(0).default(250),
  maxOutputBytes: z.number().step(1).min(1).default(DEFAULT_MAX_OUTPUT_BYTES),
  hostedWebSearch: z.boolean().default(true),
  remoteCompact: z.boolean().default(true),
  systemPrompt: z.string().default(DEFAULT_CODEX_SYSTEM_PROMPT),
  persona: z.string().default(DEFAULT_CODEX_PERSONA),
  harnessSourcePrompt: z.string().default(DEFAULT_DSH_CORE_SOURCE_PROMPT),
  webSurfacePrompt: z.string().default(DEFAULT_DSH_CORE_WEB_PROMPT),
})

const LLM_PI_AI_SETTINGS = settingsNamespace('llm-pi-ai')

/** Codex request envelope with the plugin's provider-facing service-tier field. */
export interface CodexRequestConfig extends LlmCallConfig {
  /** Codex request context capacity override, retained for older DSH hosts. */
  contextWindow?: number
  /** Provider-facing service tier, for example Responses `priority`. */
  serviceTier?: string
}

const GPT_REASONING_EFFORTS = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
} as const

type CodexReasoningEfforts = false | Record<string, string | null>

function codexReasoningEfforts(configured: CodexReasoningEfforts | undefined): CodexReasoningEfforts {
  if (configured === false) return false
  const filtered = configured === undefined
    ? {}
    : Object.fromEntries(Object.entries(configured).filter(([level]) => level !== 'off' && level !== 'minimal'))
  return Object.keys(filtered).length === 0 ? GPT_REASONING_EFFORTS : filtered
}

export interface CodexModelProfile {
  id: string
  input?: string[]
  reasoningEfforts?: false | Record<string, string | null>
  [key: string]: unknown
}

interface CodexModelOverride {
  input?: string[]
  reasoningEfforts?: false | Record<string, string | null>
  [key: string]: unknown
}

interface CodexProviderProfile {
  models?: CodexModelProfile[]
  modelOverrides?: Record<string, CodexModelOverride>
  [key: string]: unknown
}

/** GPT model ids are the only models whose relay capabilities Codex fills in. */
function isGptModel(id: string): boolean {
  return /(?:^|\/)(?:gpt|chatgpt)(?:[-_.]|\d|$)/i.test(id)
}

/** Add Codex defaults without overwriting explicit user capabilities. */
export function enrichCodexModel(model: CodexModelProfile): CodexModelProfile {
  if (!isGptModel(model.id)) return model
  const input = model.input === undefined || model.input.length === 0
    ? ['text', 'image']
    : model.input
  const efforts = codexReasoningEfforts(model.reasoningEfforts)
  if (input === model.input && efforts === model.reasoningEfforts) return model
  return { ...model, input, reasoningEfforts: efforts }
}

/** The settings schema keys modelOverrides by id, so its values must not carry an id field. */
function enrichCodexOverride(id: string, model: CodexModelOverride): CodexModelOverride {
  if (!isGptModel(id)) return model
  const enriched = enrichCodexModel({ ...model, id })
  const { id: _id, ...withoutId } = enriched
  const inputMissing = model.input === undefined || model.input.length === 0
  const nextEfforts = codexReasoningEfforts(model.reasoningEfforts)
  const reasoningChanged = JSON.stringify(nextEfforts) !== JSON.stringify(model.reasoningEfforts)
  if (!inputMissing && !reasoningChanged) return model
  return { ...withoutId, reasoningEfforts: nextEfforts }
}

interface LlmPiAiSettings {
  providers?: Record<string, CodexProviderProfile>
}

/** Persist only missing GPT capabilities into the user's existing pi-ai model config. */
async function enrichConfiguredGptModels(ctx: Context): Promise<void> {
  const settings = ctx.get('settings') as { get(ns: unknown): unknown; update(ns: unknown, patch: object): Promise<void> } | undefined
  if (settings === undefined) return
  const current = settings.get(LLM_PI_AI_SETTINGS) as LlmPiAiSettings | undefined
  if (current?.providers === undefined) return
  const providers: Record<string, Record<string, unknown>> = {}
  let changed = false
  for (const [provider, profile] of Object.entries(current.providers)) {
    const models = profile.models
    const overrides = profile.modelOverrides
    const nextModels = Array.isArray(models) ? models.map(enrichCodexModel) : undefined
    const nextOverrides = overrides === undefined
      ? undefined
      : Object.fromEntries(Object.entries(overrides).map(([id, model]) => [id, enrichCodexOverride(id, model)]))
    const modelsChanged = nextModels !== undefined && nextModels.some((model, index) => model !== models?.[index])
    const overridesChanged = nextOverrides !== undefined
      && overrides !== undefined
      && Object.entries(nextOverrides).some(([id, model]) => model !== overrides[id])
    if (modelsChanged || overridesChanged) {
      changed = true
      providers[provider] = {
        ...modelsChanged ? { models: nextModels } : {},
        ...overridesChanged ? { modelOverrides: nextOverrides } : {},
      }
    }
  }
  if (changed) await settings.update(LLM_PI_AI_SETTINGS, { providers })
}

/** Keep newly edited GPT model entries enriched while Codex mode is mounted. */
function watchConfiguredGptModels(ctx: Context): void {
  let tail = Promise.resolve()
  const schedule = (): void => {
    tail = tail.then(() => enrichConfiguredGptModels(ctx)).catch(error => {
      ctx.logger.warn('codex: could not enrich configured GPT model capabilities')
      ctx.logger.warn(error)
    })
  }
  ctx.on('settings/document-updated', (ns) => {
    if (ns === LLM_PI_AI_SETTINGS) schedule()
  })
  schedule()
}

/** Install the optional settings source used by requests and prompt assembly. */
function installCodexSettings(
  ctx: Context,
  systemPrompt: string,
  persona: string,
  harnessSourcePrompt: string,
  webSurfacePrompt: string,
): { current: () => CodexSettings } {
  const entry: CodexSettings = {
    ...CODEX_SETTINGS_ENTRY,
    systemPrompt,
    persona,
    harnessSourcePrompt,
    webSurfacePrompt,
  }
  const withDefaults = (value: CodexSettings | undefined): CodexSettings => ({
    ...entry,
    ...value,
  })
  const settings = ctx.get('settings')
  if (settings?.get(CODEX_SETTINGS_NAMESPACE) !== undefined) {
    return {
      current: () => withDefaults(settings.get(CODEX_SETTINGS_NAMESPACE) as CodexSettings | undefined),
    }
  }
  let source: () => CodexSettings = () => entry
  installSettingsSection(ctx, CODEX_SETTINGS_NAMESPACE, CODEX_SETTINGS_SCHEMA, entry, {
    setSource: (current) => { source = current },
    onChange: () => {},
  })
  return { current: () => withDefaults(source()) }
}

function hasOpenTurn(session: Session): boolean {
  const start = session.events.findLast(event => event.type === 'turn/start')
  const end = session.events.findLast(event => event.type === 'turn/end')
  return start !== undefined && (end === undefined || start.seq > end.seq)
}

/**
 * Pair the live Codex capacity with the token-meter context projection.
 *
 * The core loop records adapter metadata in `request/context`, while Codex's
 * setting is a request-scoped LLM capacity. Appending the override after the
 * loop's metadata event keeps the official ContextMeter and compaction engine
 * on the same effective capacity.
 */
export function syncCodexContextWindow(session: Session, contextWindow: number | undefined): void {
  if (contextWindow === undefined
    || !Number.isSafeInteger(contextWindow)
    || contextWindow <= 0
    || !hasOpenTurn(session)) return
  const config = session.requestHeader()?.config as {
    provider?: unknown
    model?: unknown
  } | undefined
  if (typeof config?.provider !== 'string'
    || typeof config.model !== 'string'
    || !isGptModel(config.model)) return
  const current = session.requestContext()
  if (current?.provider === config.provider
    && current.model === config.model
    && current.contextWindow === contextWindow) return
  session.append('request/context', {
    provider: config.provider,
    model: config.model,
    contextWindow,
  })
}

/** Keep the official context meter synchronized with a live Codex override. */
function installCodexContextProjection(ctx: Context, current: () => CodexSettings): void {
  const sync = (session: Session, contextWindow = current().contextWindow): void => {
    syncCodexContextWindow(session, contextWindow)
  }
  const pending = new WeakSet<Session>()
  const syncAfterPublication = (session: Session): void => {
    if (pending.has(session)) return
    pending.add(session)
    queueMicrotask(() => {
      try {
        sync(session)
      } finally {
        pending.delete(session)
      }
    })
  }
  const syncAll = (contextWindow = current().contextWindow): void => {
    const sessions = ctx.get('sessions') as { list?: () => readonly Session[] } | undefined
    for (const session of sessions?.list?.() ?? []) sync(session, contextWindow)
  }
  ctx.on('session/event', (session, event) => {
    // Session.append() rejects nested appends until every observer returns.
    if (event.type === 'request/header' || event.type === 'request/context') syncAfterPublication(session)
  })
  // Restored sessions may already contain their request/header seed, so no
  // session/event is emitted for the initial capacity. Catch them at the
  // store publication boundary as well.
  ctx.on('session/created', (session) => { sync(session) })
  // Use the resolved value carried by the consumer-facing event. This avoids
  // waiting for the settings source closure to refresh before synchronizing
  // already-open sessions.
  ctx.on('settings/updated', (ns, next) => {
    if (ns === CODEX_SETTINGS_NAMESPACE) {
      syncAll((next as CodexSettings).contextWindow)
    }
  })
  ctx.on('settings/document-updated', ns => {
    if (ns === CODEX_SETTINGS_NAMESPACE) syncAll()
  })
  syncAll()
}

/** Apply the live Codex controls to one agent request without leaking them to other routes. */
export function applyCodexRequestSettings(
  request: CodexRequestConfig,
  settings: CodexSettings,
): CodexRequestConfig {
  const {
    contextWindow: _inheritedContextWindow,
    serviceTier: _inheritedServiceTier,
    ...withoutCodexControls
  } = request
  if (!isGptModel(request.model)) return withoutCodexControls
  return {
    ...withoutCodexControls,
    ...settings.contextWindow === undefined ? {} : { contextWindow: settings.contextWindow },
    ...settings.fast ? { serviceTier: 'priority' } : {},
  }
}

/** Put the agent persona first and omit the generic Harness identity opener. */
export function normalizeCodexPromptAssembly(assembly: PromptAssembly): PromptAssembly {
  const sections = assembly.sections.filter(section => section.name !== 'harness:identity')
  const persona = sections.find(section => section.name === 'deployment:persona')
  if (persona === undefined) return { ...assembly, sections }
  return {
    ...assembly,
    sections: [persona, ...sections.filter(section => section.name !== 'deployment:persona')],
  }
}

function sectionText(assembly: PromptAssembly, name: string): string | undefined {
  const section = assembly.sections.find(candidate => candidate.name === name)
  return section?.text
}

function promptVariables(assembly: PromptAssembly): Record<string, string | undefined> {
  const variables = { ...assembly.variables }
  if (variables.sourceRoot === undefined) {
    const source = sectionText(assembly, 'harness:source')
    const match = source?.match(/^The DeepSeek Harness implementation checkout is at (.+?)\. The checkout location/u)
    if (match?.[1] !== undefined) variables.sourceRoot = match[1]
  }
  if (variables.webUrl === undefined) {
    const web = sectionText(assembly, 'app:web-surface')
    const match = web?.match(/^You are interacting with the user through the DeepSeek Harness Web GUI at (.+?)\. When/u)
    if (match?.[1] !== undefined) variables.webUrl = match[1]
  }
  return variables
}

function interpolateCodexPrompt(text: string, variables: Record<string, string | undefined>): string {
  return text.replace(/\{\{([\w.-]+)\}\}/g, (whole, key: string) => variables[key] ?? whole)
}

/** Apply user-editable Persona and DSH Core runtime prompt templates. */
function applyCodexPromptOverrides(assembly: PromptAssembly, settings: CodexSettings): PromptAssembly {
  const overrides: Record<string, string | undefined> = {
    'deployment:persona': settings.persona,
    'harness:source': settings.harnessSourcePrompt,
    'app:web-surface': settings.webSurfacePrompt,
  }
  const defaults: Record<string, string> = {
    'deployment:persona': DEFAULT_CODEX_PERSONA,
    'harness:source': DEFAULT_DSH_CORE_SOURCE_PROMPT,
    'app:web-surface': DEFAULT_DSH_CORE_WEB_PROMPT,
  }
  const hasCustomOverride = Object.entries(overrides).some(([name, text]) => (
    text !== undefined && text !== defaults[name]
  ))
  if (!hasCustomOverride) return assembly
  const variables = promptVariables(assembly)
  const sections = assembly.sections.map(section => {
    const template = overrides[section.name]
    return template === undefined || template === defaults[section.name]
      ? section
      : { ...section, text: interpolateCodexPrompt(template, variables) }
  })
  return { ...assembly, sections, variables }
}

const CODEX_TOOL_NAMES = {
  terminalToolsEnabled: new Set(['exec_command', 'write_stdin']),
  patchToolEnabled: new Set(['apply_patch']),
  planToolEnabled: new Set(['update_plan']),
} as const

/** Remove disabled Codex capabilities from the next model-visible assembly. */
export function applyCodexCapabilitySettings(
  assembly: PromptAssembly,
  settings: CodexSettings,
): PromptAssembly {
  const disabled = new Set<string>()
  for (const [setting, names] of Object.entries(CODEX_TOOL_NAMES)) {
    if (settings[setting as keyof typeof CODEX_TOOL_NAMES]) continue
    for (const name of names) disabled.add(name)
  }
  const filtered = disabled.size === 0
    ? assembly
    : { ...assembly, tools: assembly.tools.filter(tool => !disabled.has(tool.name)) }
  const withOverrides = applyCodexPromptOverrides(filtered, settings)
  return settings.promptEnabled ? normalizeCodexPromptAssembly(withOverrides) : withOverrides
}

/** Build the complete plugin-owned prompt, preserving an intentional empty value. */
export function buildCodexSystemPrompt(config: Pick<Config, 'systemPrompt'> = {}): string {
  return resolveCodexSystemPrompt(config.systemPrompt)
}

const EXEC_COMMAND_DESCRIPTION = 'Runs a command in a PTY, returning output, a session ID for ongoing interaction, or a background job ID when requested.'
const WRITE_STDIN_DESCRIPTION = 'Writes characters to an existing unified exec session and returns recent output.'
const UPDATE_PLAN_DESCRIPTION =
  'Updates the task plan.\nProvide an optional explanation and a list of plan items, each with a step and status.\nAt most one step can be in_progress at a time.'

const PLAN_STATUSES = ['pending', 'in_progress', 'completed'] as const
type PlanStatus = typeof PLAN_STATUSES[number]

interface PlanArgumentItem {
  step: string
  status: PlanStatus
}

interface UpdatePlanArgs {
  explanation?: string
  plan: PlanArgumentItem[]
}

type CapabilitySetting =
  | 'terminalToolsEnabled'
  | 'patchToolEnabled'
  | 'planToolEnabled'

interface ExecToolConfig extends Required<Config> {
  currentSettings: () => CodexSettings
}

function assertCapabilityEnabled(
  current: () => CodexSettings,
  setting: CapabilitySetting,
  toolName: string,
): void {
  if (!current()[setting]) throw new Error(`${toolName}: disabled in Codex Harness plugin settings`)
}

interface AppliedFile {
  path: string
  operation: 'created' | 'updated' | 'deleted' | 'moved'
  moveTo?: string
}

interface ApplyPatchResult {
  files: AppliedFile[]
}

function sessionCwd(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.cwd
}

function resolvePolicy(ctx: Context, exec: ToolExecution): SandboxExecutionPolicy | undefined {
  const policy = ctx.get('sandboxPolicy')
  return policy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
}

async function resolveTarget(ctx: Context, path: string, exec: ToolExecution): Promise<FsTarget> {
  const cwd = sessionCwd(exec)
  return ctx.fs.resolve(path, cwd === undefined ? { signal: exec.signal } : { cwd, signal: exec.signal })
}

async function observedTarget(ctx: Context, target: FsTarget, exec: ToolExecution): Promise<FsInfo> {
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) throw new Error(`apply_patch: file not found: ${target.displayPath}`)
  if (info.type !== 'file') throw new Error(`apply_patch: not a regular file: ${target.displayPath}`)
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
  return info
}

async function writePatchedFile(
  ctx: Context,
  target: FsTarget,
  content: string,
  fallback: FsWriteIntent,
  exec: ToolExecution,
  policy: SandboxExecutionPolicy | undefined,
): Promise<'created' | 'updated'> {
  const intent = await ctx.waterfall('fs/write-intent', target, exec, () => fallback)
  const outcome = await ctx.fs.writeText(target, content, intent, exec.signal, policy)
  ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
  return outcome.operation === 'create' ? 'created' : 'updated'
}

async function deletePatchedFile(
  ctx: Context,
  target: FsTarget,
  version: FsInfo['version'],
  exec: ToolExecution,
  policy: SandboxExecutionPolicy | undefined,
): Promise<void> {
  // The rc.6 dsh-fs service definition omits deletion, while the local and
  // sandboxed providers still expose it. Use the provider capability when it
  // exists and fail with a useful tool error for write-only backends.
  type RemoveFile = (
    target: FsTarget,
    expected: { version: FsInfo['version'] },
    signal: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ) => Promise<void>
  const remove = (ctx.fs as unknown as { remove?: RemoveFile }).remove
  if (typeof remove !== 'function') {
    throw new Error('apply_patch: the configured dsh filesystem does not support file deletion')
  }
  await remove.call(ctx.fs, target, { version }, exec.signal, policy)
  ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
}

async function applyOnePatch(
  ctx: Context,
  file: PatchFile,
  exec: ToolExecution,
  policy: SandboxExecutionPolicy | undefined,
): Promise<AppliedFile> {
  const target = await resolveTarget(ctx, file.path, exec)
  if (file.kind === 'add') {
    const existing = await ctx.fs.stat(target, exec.signal)
    if (existing !== undefined) throw new Error(`apply_patch: file already exists: ${target.displayPath}`)
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    await writePatchedFile(ctx, target, file.content, { kind: 'createIfAbsent' }, exec, policy)
    return { path: file.path, operation: 'created' }
  }

  const sourceInfo = await observedTarget(ctx, target, exec)
  const original = await ctx.fs.readText(target, exec.signal)
  const updated = file.kind === 'delete' ? undefined : applyPatchHunks(original, file.hunks, file.path)
  if (file.kind === 'delete') {
    await deletePatchedFile(ctx, target, sourceInfo.version, exec, policy)
    return { path: file.path, operation: 'deleted' }
  }
  if (file.moveTo === undefined) {
    await writePatchedFile(ctx, target, updated!, { kind: 'replaceIfVersion', version: sourceInfo.version }, exec, policy)
    return { path: file.path, operation: 'updated' }
  }

  const destination = await resolveTarget(ctx, file.moveTo, exec)
  if (destination.targetKey === target.targetKey) {
    await writePatchedFile(ctx, target, updated!, { kind: 'replaceIfVersion', version: sourceInfo.version }, exec, policy)
    return { path: file.path, operation: 'updated', moveTo: file.moveTo }
  }
  const destinationInfo = await ctx.fs.stat(destination, exec.signal)
  if (destinationInfo !== undefined) throw new Error(`apply_patch: move destination already exists: ${destination.displayPath}`)
  ctx.emit('fs/observed', destination, { kind: 'absent' }, exec)
  await writePatchedFile(ctx, destination, updated!, { kind: 'createIfAbsent' }, exec, policy)
  await deletePatchedFile(ctx, target, sourceInfo.version, exec, policy)
  return { path: file.path, operation: 'moved', moveTo: file.moveTo }
}

function patchSummary(value: ApplyPatchResult): string {
  const letter = (operation: AppliedFile['operation']): string => {
    switch (operation) {
      case 'created': return 'A'
      case 'updated': return 'M'
      case 'deleted': return 'D'
      case 'moved': return 'M'
      default: return operation satisfies never
    }
  }
  return `Success. Updated the following files:\n${value.files.map(file => `${letter(file.operation)} ${file.operation === 'moved' ? file.moveTo : file.path}`).join('\n')}\n`
}

function planTodos(args: UpdatePlanArgs): TodoItem[] {
  const seen = new Set<string>()
  let active = 0
  const todos: TodoItem[] = []
  for (const item of args.plan) {
    const content = item.step.trim()
    if (content.length === 0) throw new Error('update_plan: every step must be non-empty')
    if (seen.has(content)) throw new Error(`update_plan: duplicate step ${JSON.stringify(content)}`)
    seen.add(content)
    if (item.status === 'in_progress') active++
    todos.push({ content, status: item.status })
  }
  if (active > 1) throw new Error('update_plan: at most one step may be in_progress')
  return todos
}

function registerExecTools(ctx: Context, config: ExecToolConfig): void {
  ctx.tools.register(defineTool({
    name: 'exec_command',
    description: EXEC_COMMAND_DESCRIPTION,
    parameters: {
      cmd: { type: 'string', required: true, description: 'Shell command to execute.' },
      workdir: { type: 'string', description: 'Working directory for the command. Defaults to the turn cwd.' },
      tty: { type: 'boolean', description: 'True allocates a PTY for the command; false or omitted uses plain pipes.' },
      run_in_background: { type: 'boolean', description: 'Run as a DSH background job and return its job id immediately; collect output with job_output and stop it with job_kill. Only supported for pipe-backed commands.' },
      yield_time_ms: { type: 'number', description: 'Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.' },
      max_output_tokens: { type: 'number', description: 'Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.' },
      shell: { type: 'string', description: "Shell binary to launch. Defaults to the user's default shell." },
      login: { type: 'boolean', description: 'True runs the shell with -l/-i semantics; false disables them. Defaults to true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chunk_id: { type: 'string' },
          wall_time_seconds: { type: 'number', required: true },
          exit_code: { type: 'number' },
          session_id: { type: 'number' },
          job_id: { type: 'string' },
          original_token_count: { type: 'number' },
          output: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderExecResult(value) }],
    },
    async execute(args: ExecCommandArgs, exec): Promise<ExecResult> {
      assertCapabilityEnabled(config.currentSettings, 'terminalToolsEnabled', 'exec_command')
      return runExecCommand(ctx, args, exec, config)
    },
    presentCall: args => ({
      card: 'terminal',
      title: args.cmd,
      ...args.workdir === undefined ? {} : { cwd: args.workdir },
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'write_stdin',
    description: WRITE_STDIN_DESCRIPTION,
    parameters: {
      session_id: { type: 'number', required: true, description: 'Identifier of the running unified exec session.' },
      chars: { type: 'string', description: 'Bytes to write to stdin. Defaults to empty, which polls without writing.' },
      yield_time_ms: { type: 'number', description: 'Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.' },
      max_output_tokens: { type: 'number', description: 'Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chunk_id: { type: 'string' },
          wall_time_seconds: { type: 'number', required: true },
          exit_code: { type: 'number' },
          session_id: { type: 'number' },
          original_token_count: { type: 'number' },
          output: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderExecResult(value) }],
    },
    async execute(args: WriteStdinArgs, exec): Promise<ExecResult> {
      assertCapabilityEnabled(config.currentSettings, 'terminalToolsEnabled', 'write_stdin')
      return runWriteStdin(ctx, args, exec, config)
    },
  }))
}

function registerPatchTool(ctx: Context, currentSettings: () => CodexSettings): void {
  ctx.tools.register(defineTool({
    name: 'apply_patch',
    description: APPLY_PATCH_DESCRIPTION,
    parameters: {
      input: { type: 'string', required: true, description: 'The complete patch text.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                operation: { type: 'string', required: true, enum: ['created', 'updated', 'deleted', 'moved'] },
                moveTo: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: patchSummary(value) }],
    },
    async execute(args: { input: string }, exec): Promise<ApplyPatchResult> {
      assertCapabilityEnabled(currentSettings, 'patchToolEnabled', 'apply_patch')
      const files = parsePatch(args.input)
      const policy = resolvePolicy(ctx, exec)
      const applied: AppliedFile[] = []
      for (const file of files) applied.push(await applyOnePatch(ctx, file, exec, policy))
      return { files: applied }
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: 'Apply patch',
        kind: 'edit',
        rawInput: args.input,
      }
    },
  }))
}

function registerPlanTool(ctx: Context, currentSettings: () => CodexSettings): void {
  ctx.tools.register(defineTool({
    name: 'update_plan',
    description: UPDATE_PLAN_DESCRIPTION,
    parameters: {
      explanation: { type: 'string', description: 'Optional explanation for this plan update.' },
      plan: {
        type: 'array',
        required: true,
        description: 'The list of steps',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            step: { type: 'string', required: true, description: 'Task step text.' },
            status: { type: 'string', required: true, enum: [...PLAN_STATUSES], description: 'Step status.' },
          },
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: () => [{ type: 'text', text: 'Plan updated' }],
    },
    execute(args: UpdatePlanArgs, exec): Promise<Record<string, never>> {
      assertCapabilityEnabled(currentSettings, 'planToolEnabled', 'update_plan')
      const agent = exec.agent
      if (agent === undefined) throw new Error('update_plan requires an owning agent session')
      agent.session.append('todo/write', { todos: planTodos(args) })
      return Promise.resolve({})
    },
  }))
}

/** Mount the Codex prompt/tool layer inside one fixed agent preset. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = {
    globalEnhancements: config.globalEnhancements ?? true,
    codexCore: config.codexCore ?? true,
    defaultYieldTimeMs: config.defaultYieldTimeMs ?? 10_000,
    pollYieldTimeMs: config.pollYieldTimeMs ?? 5_000,
    writeYieldTimeMs: config.writeYieldTimeMs ?? 250,
    maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    hostedWebSearch: config.hostedWebSearch ?? true,
    remoteCompact: config.remoteCompact ?? true,
    systemPrompt: config.systemPrompt ?? DEFAULT_CODEX_SYSTEM_PROMPT,
    persona: config.persona ?? DEFAULT_CODEX_PERSONA,
    harnessSourcePrompt: config.harnessSourcePrompt ?? DEFAULT_DSH_CORE_SOURCE_PROMPT,
    webSurfacePrompt: config.webSurfacePrompt ?? DEFAULT_DSH_CORE_WEB_PROMPT,
  }
  if (resolved.codexCore
    && ctx.fs.sandboxMode !== undefined
    && ctx.get('sandboxPolicy') === undefined) {
    throw new Error('codex: a sandboxing filesystem requires ctx.sandboxPolicy')
  }
  const codexSettings = installCodexSettings(
    ctx,
    resolved.systemPrompt,
    resolved.persona,
    resolved.harnessSourcePrompt,
    resolved.webSurfacePrompt,
  )
  const execConfig = { ...resolved, currentSettings: codexSettings.current }

  if (resolved.globalEnhancements) {
    // The generic pi-ai plugin remains the owner of provider routes. This
    // layer adds only request metadata and remote-first transport behavior.
    watchConfiguredGptModels(ctx)
    registerCodexActivityProjection(ctx)
    installCodexContextProjection(ctx, codexSettings.current)
    ctx.on('agent/request', async (_payload, next) => {
      const request = await next()
      return applyCodexRequestSettings(request, codexSettings.current())
    })
    if (typeof (ctx as unknown as { effect?: unknown }).effect === 'function') {
      const disposeHostedWebSearch = installHostedWebSearch()
      ctx.effect(() => disposeHostedWebSearch, 'codex: Responses transport wrapper')
    }
    ctx.on('llm/stream', ((options: any, next: any) => {
      const settings = codexSettings.current()
      const contextWindow = options.contextWindow ?? settings.contextWindow
      const compactionMode = codexCompactionMode()
      const legacySafeNext = () => repairLegacyPiAiContextOverflow(
        next(),
        options.model,
        contextWindow,
      )
      if (options.purpose === 'compaction' && isGptModel(options.model)) {
        const useRemoteCompaction = compactionMode === 'remote'
          || (compactionMode !== 'local' && resolved.remoteCompact && settings.remoteCompactionEnabled)
        if (useRemoteCompaction) {
          return remoteCompactStream(ctx, options, legacySafeNext, {
            hostedWebSearch: resolved.hostedWebSearch && settings.hostedWebSearchEnabled,
            customApplyPatch: settings.patchToolEnabled,
          })
        }
        return legacySafeNext()
      }
      if (options.purpose === undefined && isGptModel(options.model)) {
        return repairLegacyPiAiContextOverflow(
          hostedWebSearchStream(next, {
            serviceTier: options.serviceTier,
            hostedWebSearch: resolved.hostedWebSearch && settings.hostedWebSearchEnabled,
            customApplyPatch: settings.patchToolEnabled,
          }),
          options.model,
          contextWindow,
        )
      }
      return next()
    }) as any)
  }

  if (resolved.codexCore) {
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) =>
      applyCodexCapabilitySettings(await next(), codexSettings.current()))
    ctx.systemPrompt.section({
      name: 'codex:base',
      order: 10,
      text: () => codexSettings.current().promptEnabled
        ? resolveCodexSystemPrompt(codexSettings.current().systemPrompt)
        : '',
    })
    registerExecTools(ctx, execConfig)
    registerPatchTool(ctx, codexSettings.current)
    registerPlanTool(ctx, codexSettings.current)
  }
}

export default { name, inject, Config, apply }

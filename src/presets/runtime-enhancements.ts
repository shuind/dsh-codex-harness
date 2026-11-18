/** Host runtime enhancements: GPT model enrichment, context-window projection, and prompt templates. */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import {
  DEFAULT_CODEX_PERSONA,
  DEFAULT_DSH_CORE_SOURCE_PROMPT,
  DEFAULT_DSH_CORE_WEB_PROMPT,
  resolveCodexSystemPrompt,
} from '../contracts/prompt.ts'
import { CODEX_SETTINGS_NAMESPACE, isGptModel, readHostSettings } from '../contracts/settings.ts'
import type { CodexSettings } from '../contracts/settings.ts'
import {
  OPENAI_CODEX_MODEL_LIMITS,
  OPENAI_CODEX_PROVIDER,
  OPENAI_CODEX_SETTINGS_NAMESPACE,
} from '../contracts/ui-contracts.ts'
import { CodexPresetEditor } from './preset-editor.ts'

/** Add the preset editor when DSH's optional user-preset service is available. */
export function installPresetEditor(ctx: Context): void {
  // `agentPresets` is supplied by dsh-agent-presets and may be installed after
  // this plugin. Waiting through inject keeps the Codex core usable on hosts
  // without that optional service while still mounting the Remote as soon as
  // the Web preset catalog becomes available.
  ctx.inject(['agentPresets'], presetCtx => {
    void (async () => {
      try {
        await presetCtx.plugin(CodexPresetEditor)
      } catch (error) {
        ctx.logger.warn('codex: preset editor is unavailable on this host')
        ctx.logger.warn(error)
      }
    })()
  })
}

const LLM_PI_AI_SETTINGS = 'llm-pi-ai' as const

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

interface LlmPiAiSettings {
  providers?: Record<string, CodexProviderProfile>
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

/** Persist only missing GPT capabilities into the user's existing pi-ai model config. */
async function enrichConfiguredGptModels(ctx: Context): Promise<void> {
  const settings = ctx.get('settings') as { update(ns: string, patch: object): Promise<void> } | undefined
  if (settings === undefined) return
  const current = readHostSettings<LlmPiAiSettings>(ctx, LLM_PI_AI_SETTINGS)
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
export function watchConfiguredGptModels(ctx: Context): void {
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

type CodexPromptPresentation = Pick<PromptAssembly, 'sections' | 'contexts' | 'variables'>

type SessionEvent = { type: string; seq: number }

function hasOpenTurn(session: Session): boolean {
  const events = session.snapshotEvents() as readonly SessionEvent[]
  const start = events.findLast(event => event.type === 'turn/start')
  const end = events.findLast(event => event.type === 'turn/end')
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
function appendRequestContextWindow(
  session: Session,
  provider: string,
  model: string,
  contextWindow: number,
): void {
  const current = session.requestContext()
  if (current?.provider === provider
    && current.model === model
    && current.contextWindow === contextWindow) return
  session.append('request/context', {
    provider,
    model,
    contextWindow,
    // Capacity is only one field of the routed capability snapshot.
    ...current?.provider === provider && current.model === model ? {
      ...current.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: current.systemPromptUpdate },
    } : {},
  })
}

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
    || config.provider === OPENAI_CODEX_PROVIDER
    || typeof config.model !== 'string'
    || !isGptModel(config.model)) return
  appendRequestContextWindow(session, config.provider, config.model, contextWindow)
}

/** Keep open Codex Connect turns aligned with per-model `llm-openai-codex` overrides. */
export function syncOpenAICodexTurnContext(ctx: Context, session: Session): void {
  if (!hasOpenTurn(session)) return
  const config = session.requestHeader()?.config as { provider?: unknown; model?: unknown } | undefined
  if (config?.provider !== OPENAI_CODEX_PROVIDER || typeof config.model !== 'string' || !isGptModel(config.model)) return
  const overrides = readHostSettings<{ contextWindowOverrides?: Record<string, number | null> }>(
    ctx,
    OPENAI_CODEX_SETTINGS_NAMESPACE,
  )?.contextWindowOverrides
  const override = overrides?.[config.model]
  const llm = ctx.get('llm') as {
    resolveModelInfo?: (provider: string, model: string) => { contextWindow?: number } | undefined
  } | undefined
  const effective = typeof override === 'number' && Number.isSafeInteger(override) && override > 0
    ? override
    : OPENAI_CODEX_MODEL_LIMITS[config.model]?.defaultTokens
      ?? llm?.resolveModelInfo?.(OPENAI_CODEX_PROVIDER, config.model)?.contextWindow
  if (effective === undefined || !Number.isSafeInteger(effective) || effective <= 0) return
  appendRequestContextWindow(session, OPENAI_CODEX_PROVIDER, config.model, effective)
}

/** Keep the official context meter synchronized with a live Codex override. */
export function installCodexContextProjection(ctx: Context, current: () => CodexSettings): void {
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
  const listSessions = (): readonly Session[] => {
    const sessions = ctx.get('sessions') as { list?: () => readonly Session[] } | undefined
    return sessions?.list?.() ?? []
  }
  const syncAll = (contextWindow = current().contextWindow): void => {
    for (const session of listSessions()) sync(session, contextWindow)
  }
  ctx.on('session/event', (session, event) => {
    // Session.append() rejects nested appends until every observer returns.
    if (event.type === 'request/header' || event.type === 'request/context') syncAfterPublication(session)
  })
  // Restored sessions may already contain their request/header seed, so no
  // session/event is emitted for the initial capacity. Catch them at the
  // store publication boundary as well.
  ctx.on('session/created', syncAfterPublication)
  ctx.on('settings/document-updated', ns => {
    if (ns === CODEX_SETTINGS_NAMESPACE) syncAll()
    else if (ns === OPENAI_CODEX_SETTINGS_NAMESPACE) {
      for (const session of listSessions()) syncOpenAICodexTurnContext(ctx, session)
    }
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
  if (request.provider === 'openai-codex' || !isGptModel(request.model)) return withoutCodexControls
  return {
    ...withoutCodexControls,
    ...settings.contextWindow === undefined ? {} : { contextWindow: settings.contextWindow },
    ...settings.fast ? { serviceTier: 'priority' } : {},
  }
}

/** Put the agent persona first and omit the generic Harness identity opener. */
export function normalizeCodexPromptAssembly<T extends CodexPromptPresentation>(assembly: T): T {
  const sections = assembly.sections.filter(section => section.name !== 'harness:identity')
  const persona = sections.find(section => section.name === 'deployment:persona-prefix')
    ?? sections.find(section => section.name === 'deployment:persona')
  if (persona === undefined) return { ...assembly, sections }
  return {
    ...assembly,
    sections: [persona, ...sections.filter(section => section !== persona)],
  }
}

function unquoteContextValue(raw: string): string {
  const trimmed = raw.trim().replace(/\.$/, '')
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (typeof parsed === 'string') return parsed
    } catch {
      // Leave unparsed literal text when not a valid JSON string literal.
    }
  }
  return trimmed
}

function cwdContextValue(cwdText: string | undefined): string | undefined {
  const match = cwdText?.match(/^Current working directory:\s*(.+?)\.?$/u)
  return match?.[1] === undefined ? undefined : unquoteContextValue(match[1])
}

function promptVariables(assembly: CodexPromptPresentation): Record<string, string | undefined> {
  const variables = { ...assembly.variables }
  if (variables.cwd === undefined) {
    const cwdText = assembly.contexts?.find(candidate => candidate.name === 'working-directory:current')?.text
    const contextMatch = cwdContextValue(cwdText)
    if (contextMatch !== undefined) variables.cwd = contextMatch
  }
  if (variables.sourceRoot === undefined) {
    const source = assembly.sections.find(candidate => candidate.name === 'harness:source')?.text
    const legacyMatch = source?.match(/^The DeepSeek Harness implementation checkout is at (.+?)\. The checkout location/u)
    if (legacyMatch?.[1] !== undefined) {
      variables.sourceRoot = legacyMatch[1]
    } else {
      const ctxText = assembly.contexts?.find(candidate => candidate.name === 'harness:source')?.text
      const contextMatch = ctxText?.match(/^Current DeepSeek Harness implementation checkout:\s*(.+?)\.?$/u)
      if (contextMatch?.[1] !== undefined) variables.sourceRoot = unquoteContextValue(contextMatch[1])
    }
  }
  if (variables.webUrl === undefined) {
    const web = assembly.sections.find(candidate => candidate.name === 'app:web-surface')?.text
    const legacyMatch = web?.match(/^You are interacting with the user through the DeepSeek Harness Web GUI at (.+?)\. When/u)
    if (legacyMatch?.[1] !== undefined) {
      variables.webUrl = legacyMatch[1]
    } else {
      const ctxText = assembly.contexts?.find(candidate => candidate.name === 'app:web-surface')?.text
      const contextMatch = ctxText?.match(/^Current DeepSeek Harness Web GUI URL:\s*(.+?)\.?$/u)
      if (contextMatch?.[1] !== undefined) variables.webUrl = unquoteContextValue(contextMatch[1])
    }
  }
  return variables
}

function interpolateCodexPrompt(text: string, variables: Record<string, string | undefined>): string {
  return text.replace(/\{\{([\w.-]+)\}\}/g, (whole, key: string) => variables[key] ?? whole)
}

/** Apply user-editable Persona and DSH Core runtime prompt templates. */
function applyCodexPromptOverrides<T extends CodexPromptPresentation>(assembly: T, settings: CodexSettings): T {
  const overrides: Record<string, string | undefined> = {
    'deployment:persona': settings.persona,
    'deployment:persona-prefix': settings.persona,
    'harness:source': settings.harnessSourcePrompt,
    'app:web-surface': settings.webSurfacePrompt,
  }
  const defaults: Record<string, string> = {
    'deployment:persona': DEFAULT_CODEX_PERSONA,
    'deployment:persona-prefix': DEFAULT_CODEX_PERSONA,
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

/** Apply Persona/DSH Core prompt overrides and optional ordering normalization. */
export function applyCodexPresentationSettings<T extends CodexPromptPresentation>(
  assembly: T,
  settings: CodexSettings,
  protectedNames?: ReadonlySet<string>,
): T {
  const promptSettings = { ...settings }
  if (protectedNames?.has('deployment:persona-prefix')) delete promptSettings.persona
  const withOverrides = applyCodexPromptOverrides(assembly, promptSettings)
  const normalized = settings.promptEnabled ? normalizeCodexPromptAssembly(withOverrides) : withOverrides
  if (normalized.variables.cwd === undefined
    && normalized.sections.some(section => section.interpolate !== false && section.text.includes('{{cwd}}'))) {
    const variables = promptVariables(normalized)
    if (variables.cwd !== undefined) return { ...normalized, variables }
  }
  return normalized
}

/** Build the complete plugin-owned prompt, preserving an intentional empty value. */
export function buildCodexSystemPrompt(config: { systemPrompt?: string } = {}): string {
  return resolveCodexSystemPrompt(config.systemPrompt)
}

/** Explicit preset instructions win without changing shared tools or permissions. */
export function withPresetPrompt(settings: CodexSettings, presetPrompt: string | undefined): CodexSettings {
  return presetPrompt === undefined ? settings : { ...settings, systemPrompt: presetPrompt }
}

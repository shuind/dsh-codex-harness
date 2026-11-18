/** Codex compaction backend that honors the latest durable request capacity. */

import { AsyncLocalStorage } from 'node:async_hooks'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Session } from '@deepseek-ai/dsh-session'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import { CODEX_SETTINGS_NAMESPACE, isGptModel, readHostSettings } from '../contracts/settings.ts'
import type { CodexSettings } from '../contracts/settings.ts'

type LlmService = NonNullable<Context['llm']>
type CodexGenerateOptions = GenerateOptions & { contextWindow?: number }

/** Per-command compaction preference propagated into the LLM stream seam. */
export type CodexCompactionMode = 'remote' | 'local'

/**
 * The main plugin entry and the compact-command subpath can be evaluated as
 * separate bundles. Keep their async context carrier on the process global so
 * an explicit command mode reaches the global llm/stream listener.
 */
const COMPACTION_MODE_KEY = Symbol.for('shuind.dsh-codex-harness.compaction-mode')
const COMPACTION_MODE = (() => {
  const registry = globalThis as unknown as Record<PropertyKey, unknown>
  const existing = registry[COMPACTION_MODE_KEY]
  if (existing !== undefined) return existing as AsyncLocalStorage<CodexCompactionMode>
  const storage = new AsyncLocalStorage<CodexCompactionMode>()
  registry[COMPACTION_MODE_KEY] = storage
  return storage
})()

/** Run one manual compaction with an explicit local/remote preference. */
export function runCodexCompactionMode<T>(
  mode: CodexCompactionMode,
  task: () => Promise<T>,
): Promise<T> {
  return COMPACTION_MODE.run(mode, task)
}

/** Read the explicit preference for the current compaction stream, if any. */
export function codexCompactionMode(): CodexCompactionMode | undefined {
  return COMPACTION_MODE.getStore()
}

interface ConfiguredContextWindow {
  /** Whether the settings service is available and therefore authoritative. */
  available: boolean
  /** The current explicit override; absent means use the model default. */
  value?: number
}

/** Read the live Codex capacity without requiring a custom LLM service API. */
function configuredContextWindow(ctx: Context): ConfiguredContextWindow {
  const settings = ctx.get('settings') as { describe?: unknown } | undefined
  const preferences = ctx.get('codexPreferences') as { current?: unknown } | undefined
  if (settings?.describe === undefined && preferences?.current === undefined) return { available: false }
  const value = readHostSettings<Pick<CodexSettings, 'contextWindow'>>(ctx, CODEX_SETTINGS_NAMESPACE)
  return {
    available: true,
    ...value?.contextWindow !== undefined
    && Number.isSafeInteger(value.contextWindow)
    && value.contextWindow > 0
      ? { value: value.contextWindow }
      : {},
  }
}

/** Read an explicit capacity persisted in the request header when settings are unavailable. */
function requestContextWindow(session: Session, provider: string, model: string): number | undefined {
  const config = session.requestHeader()?.config as {
    provider?: unknown
    model?: unknown
    contextWindow?: unknown
  } | undefined
  if (config?.provider !== provider || config.model !== model) return undefined
  const value = config.contextWindow
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Resolve the capacity currently in force for an active Codex compaction. */
function activeContextWindow(
  ctx: Context,
  activeSession: AsyncLocalStorage<Session>,
  provider: string,
  model: string,
): number | undefined {
  if (provider === 'openai-codex') return undefined
  const session = activeSession.getStore()
  const requestContext = session?.requestContext()
  const configured = isGptModel(model)
    ? configuredContextWindow(ctx)
    : { available: false }
  // A live setting must win before the old request header: automatic pressure
  // runs before the next request rebuilds that header.
  return configured.available
    ? configured.value
    : (session === undefined ? undefined : requestContextWindow(session, provider, model))
      ?? (requestContext?.provider === provider && requestContext.model === model
        ? requestContext.contextWindow
        : undefined)
}

const DSH_COMPACT_PROMPT_PREFIX = 'You are now acting as a compaction engine'

/**
 * When `/compact local` is active, neutralize DSH's exact compaction prompt
 * prefix on a shallow clone so external adapters (`dsh-codex-connect`) fall
 * through to local text summarization instead of firing `compaction_trigger`.
 */
export function withExplicitLocalCompactionInstruction(options: CodexGenerateOptions): CodexGenerateOptions {
  if (codexCompactionMode() !== 'local' || options.purpose !== 'compaction' || options.messages.length === 0) {
    return options
  }
  const last = options.messages.at(-1)
  if (last === undefined || last.role !== 'user' || ('id' in last && last.id !== undefined)) {
    return options
  }
  const first = last.content[0]
  if (first === undefined || first.type !== 'text' || !first.text.startsWith(DSH_COMPACT_PROMPT_PREFIX)) {
    return options
  }
  const updatedLast = {
    ...last,
    content: [{ ...first, text: `\n${first.text}` }, ...last.content.slice(1)],
  }
  return {
    ...options,
    messages: [...options.messages.slice(0, -1), updatedLast] as GenerateOptions['messages'],
  }
}

/** Overlay capacity lookup and auxiliary summary requests for compaction. */
function withDurableContextCapacity(
  llm: LlmService,
  ctx: Context,
  activeSession: AsyncLocalStorage<Session>,
): LlmService {
  return new Proxy(llm, {
    get(target, property) {
      if (property === 'resolveModelInfo') {
        return async (provider: string, model: string, signal?: AbortSignal) => {
          const info = await target.resolveModelInfo(provider, model, signal)
          const contextWindow = activeContextWindow(ctx, activeSession, provider, model)
          if (contextWindow === undefined) return info
          return {
            ...info,
            context: { ...info.context, contextWindow },
          }
        }
      }
      if (property === 'stream') {
        return (options: CodexGenerateOptions) => {
          const contextWindow = activeContextWindow(ctx, activeSession, options.provider, options.model)
          const patched = withExplicitLocalCompactionInstruction(options)
          if (contextWindow === undefined || patched.contextWindow === contextWindow) {
            return target.stream(patched)
          }
          return target.stream({ ...patched, contextWindow } as GenerateOptions)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as LlmService
}

/**
 * Keep the upstream compaction policy, retention, overflow recovery, and
 * transaction implementation intact. The scoped LLM seam changes only the
 * context metadata returned during a pressure check.
 */
export default class CodexCompactionEngine extends BasicCompactionEngine {
  static override inject = BasicCompactionEngine.inject
  static override Config = BasicCompactionEngine.Config

  readonly codexSmallWindowReady = true
  private readonly activeSession: AsyncLocalStorage<Session>

  constructor(ctx: Context, config: ConstructorParameters<typeof BasicCompactionEngine>[1] = {}) {
    const activeSession = new AsyncLocalStorage<Session>()
    const llm = ctx.get('llm')
    if (llm === undefined) throw new Error('codex compaction requires ctx.llm')
    const normalizedConfig = {
      ...config,
      headroomTokens: config.headroomTokens ?? 8_192,
      maxTokens: config.maxTokens ?? config.headroomTokens ?? 65_536,
    }
    super(ctx.extend({ llm: withDurableContextCapacity(llm, ctx, activeSession) }), normalizedConfig)
    this.activeSession = activeSession
  }

  override compactIfNeeded(
    agent: Parameters<BasicCompactionEngine['compactIfNeeded']>[0],
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    return this.activeSession.run(agent.session, () => super.compactIfNeeded(agent, trigger, signal))
  }

  override compactRegion(
    ...args: Parameters<BasicCompactionEngine['compactRegion']>
  ): Promise<CompactionResult> {
    return this.activeSession.run(args[2].session, () => super.compactRegion(...args))
  }

  override compactNow(
    agent: Parameters<BasicCompactionEngine['compactNow']>[0],
    signal: AbortSignal,
    sourceCommandId?: Parameters<BasicCompactionEngine['compactNow']>[2],
  ): Promise<CompactionResult | null> {
    return this.activeSession.run(
      agent.session,
      () => super.compactNow(agent, signal, sourceCommandId),
    )
  }
}

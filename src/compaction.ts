/** Codex compaction backend that honors the latest durable request capacity. */

import { AsyncLocalStorage } from 'node:async_hooks'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

type LlmService = NonNullable<Context['llm']>
type CodexGenerateOptions = GenerateOptions & { contextWindow?: number }

const CODEX_SETTINGS_NAMESPACE = settingsNamespace('codex')

interface CodexSettings {
  contextWindow?: number
}

/** Codex context overrides apply only to GPT-compatible model routes. */
function isGptModel(model: string): boolean {
  return /(?:^|\/)(?:gpt|chatgpt)(?:[-_.]|\d|$)/i.test(model)
}

interface ConfiguredContextWindow {
  /** Whether the settings service is available and therefore authoritative. */
  available: boolean
  /** The current explicit override; absent means use the model default. */
  value?: number
}

/** Read the live Codex capacity without requiring a custom LLM service API. */
function configuredContextWindow(ctx: Context): ConfiguredContextWindow {
  const settings = ctx.get('settings') as { get?: (namespace: unknown) => unknown } | undefined
  if (settings?.get === undefined) return { available: false }
  const value = settings?.get?.(CODEX_SETTINGS_NAMESPACE) as CodexSettings | undefined
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
          if (contextWindow === undefined || options.contextWindow === contextWindow) {
            return target.stream(options)
          }
          return target.stream({ ...options, contextWindow } as GenerateOptions)
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

  private readonly activeSession: AsyncLocalStorage<Session>

  constructor(ctx: Context, config: ConstructorParameters<typeof BasicCompactionEngine>[1] = {}) {
    const activeSession = new AsyncLocalStorage<Session>()
    const llm = ctx.get('llm')
    if (llm === undefined) throw new Error('codex compaction requires ctx.llm')
    super(ctx.extend({ llm: withDurableContextCapacity(llm, ctx, activeSession) }), config)
    this.activeSession = activeSession
  }

  override compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    return this.activeSession.run(agent.session, () => super.compactIfNeeded(agent, trigger, signal))
  }

  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: Parameters<BasicCompactionEngine['compactNow']>[2],
  ): Promise<CompactionResult | null> {
    return this.activeSession.run(
      agent.session,
      () => super.compactNow(agent, signal, sourceCommandId),
    )
  }
}

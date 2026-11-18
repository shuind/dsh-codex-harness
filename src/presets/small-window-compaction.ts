/** Automatic compaction fallback when a GPT session uses a window below DSH's 65K headroom floor. */

import type { Context } from '@deepseek-ai/cordis'
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { isGptModel } from '../contracts/settings.ts'
import type { CodexSettings } from '../contracts/settings.ts'

const UPSTREAM_HEADROOM_FLOOR = 80_000
const DEFAULT_SMALL_THRESHOLD_RATIO = 0.8
const DEFAULT_SMALL_RETAIN_RATIO = 0.16

interface CompactRange {
  readonly start: SessionSeq
  readonly end: SessionSeq
}

interface ScopedCompactionService {
  readonly codexSmallWindowReady?: boolean
  compactRegion?: (start: SessionSeq, end: SessionSeq, agent: unknown, signal: AbortSignal) => Promise<unknown>
}

interface AgentPresetsLookup {
  serviceFor?: (agent: unknown, name: string) => unknown
}

interface AgentLike {
  readonly ctx?: Context
  readonly session: Session
}

/** Select the oldest tool-balanced span outside `retainTokens`, preserving a leading system node. */
export function selectSmallWindowRange(
  session: Session,
  measurement: TokenMeasurement,
  retainTokens: number,
): CompactRange | null {
  const pricedNodes = measurement.nodes
  if (pricedNodes.length === 0) return null
  const surfaceNodes = session.surface.nodes
  if (surfaceNodes.length !== pricedNodes.length
    || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) return null
  const firstIdx = session.eventAt(surfaceNodes[0]!)?.type === 'system/message' ? 1 : 0
  let accumulated = 0
  let keepFromIdx = pricedNodes.length
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    accumulated += pricedNodes[index]!.tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  while (keepFromIdx > firstIdx && !toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx]!)) {
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstIdx) return null
  return { start: surfaceNodes[firstIdx]!, end: surfaceNodes[keepFromIdx - 1]! }
}

async function compactSmallWindowIfNeeded(
  ctx: Context,
  agent: AgentLike,
  header: { readonly config?: { readonly provider?: unknown; readonly model?: unknown; readonly contextWindow?: unknown } },
  signal: AbortSignal,
  currentSettings: () => CodexSettings,
  requireBelowThreshold: boolean,
): Promise<void> {
  const provider = header.config?.provider
  const model = header.config?.model
  if (typeof provider !== 'string' || typeof model !== 'string' || !isGptModel(model)) return

  const agentCtx = agent.ctx ?? ctx
  const agentPresets = (ctx as unknown as {
    get?: (name: string) => AgentPresetsLookup | undefined
  }).get?.('agentPresets')
  const compaction = (agentPresets?.serviceFor?.(agent, 'compaction') ?? agentCtx.get('compaction')) as ScopedCompactionService | undefined
  if (compaction?.compactRegion === undefined || compaction.codexSmallWindowReady === true) return
  const tokenMeter = agentCtx.get('tokenMeter') as {
    measure?: (session: Session, header?: unknown) => TokenMeasurement
  } | undefined
  if (tokenMeter?.measure === undefined) return

  const llm = agentCtx.get('llm') as {
    resolveModelInfo?: (p: string, m: string, s?: AbortSignal) => Promise<{ context?: { contextWindow?: number } } | undefined>
  } | undefined
  const info = await llm?.resolveModelInfo?.(provider, model, signal)
  const headerWindow = typeof header.config?.contextWindow === 'number' ? header.config.contextWindow : undefined
  const effectiveWindow = provider === 'openai-codex'
    ? info?.context?.contextWindow
    : (currentSettings().contextWindow ?? headerWindow ?? info?.context?.contextWindow)
  if (typeof effectiveWindow !== 'number'
    || !Number.isSafeInteger(effectiveWindow)
    || effectiveWindow <= 0
    || effectiveWindow >= UPSTREAM_HEADROOM_FLOOR) return

  const thresholdTokens = Math.max(1_024, Math.floor(effectiveWindow * DEFAULT_SMALL_THRESHOLD_RATIO))
  const retainTokens = Math.floor(effectiveWindow * DEFAULT_SMALL_RETAIN_RATIO)
  let measurement = tokenMeter.measure(agent.session, header)
  if (measurement.totalTokens < thresholdTokens) return

  const pruner = (agentPresets?.serviceFor?.(agent, 'toolResultPruner') ?? agentCtx.get('toolResultPruner')) as { pruneSession?: (session: Session) => void } | undefined
  if (pruner?.pruneSession !== undefined) {
    pruner.pruneSession(agent.session)
    measurement = tokenMeter.measure(agent.session, header)
    if (measurement.totalTokens < thresholdTokens) return
  }

  for (let attempt = 0; attempt <= 1; attempt += 1) {
    const range = selectSmallWindowRange(agent.session, measurement, retainTokens)
    if (range === null) {
      if (requireBelowThreshold) throw new Error('no safe compaction range can reduce context below small-window threshold')
      return
    }
    await compaction.compactRegion(range.start, range.end, agent, signal)
    measurement = tokenMeter.measure(agent.session, header)
    if (measurement.totalTokens < thresholdTokens) return
  }
  if (requireBelowThreshold) throw new Error('compaction still above small-window threshold')
}

/** Bridge pre-step and model-switch compaction for small GPT windows under BasicCompactionEngine. */
export function installSmallWindowCompaction(
  ctx: Context,
  currentSettings: () => CodexSettings,
  lastRequestByAgent: WeakMap<object, unknown>,
): void {
  ctx.on('agent/pre-step', (async ({ agent, signal }: { agent: AgentLike; signal: AbortSignal }, next: () => Promise<unknown>) => {
    if (!signal.aborted) {
      try {
        const header = agent.session.requestHeader()
        if (header !== undefined) await compactSmallWindowIfNeeded(ctx, agent, header, signal, currentSettings, false)
      } catch (error) {
        (ctx.logger as { warn?: (value: unknown) => void } | undefined)?.warn?.(error)
      }
    }
    return next()
  }) as never, { prepend: true } as never)

  ctx.on('agent/request', (async (payload: { agent?: AgentLike; signal?: AbortSignal }, next: () => Promise<unknown>) => {
    try {
      return await next()
    } catch (error) {
      const code = (error as { code?: unknown } | undefined)?.code
      const causeText = String((error as { cause?: unknown } | undefined)?.cause ?? error)
      const agent = payload.agent
      const resolvedConfig = agent !== undefined && typeof agent === 'object' ? lastRequestByAgent.get(agent) : undefined
      if (!payload.signal?.aborted
        && code === 'MODEL_SWITCH_COMPACTION_FAILED'
        && causeText.includes('headroom tokens')
        && agent !== undefined
        && resolvedConfig !== undefined
        && payload.signal !== undefined) {
        const previous = agent.session.requestHeader()
        await compactSmallWindowIfNeeded(
          ctx,
          agent,
          { ...previous, config: resolvedConfig as Record<string, unknown> },
          payload.signal,
          currentSettings,
          true,
        )
        return resolvedConfig
      }
      throw error
    }
  }) as never, { prepend: true } as never)
}

/** Progressive deferred tool activation (`deferLoading: true`) and preset defaults. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction/types'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export const ACTIVATE_TOOLS_NAME = 'activate_tools'
export const CODEX_HYBRID_DEFAULTS_SERVICE = 'codexHybridDefaults' as const
export const DEFERRED_RECENT_TURN_WINDOW = 2

export interface CodexHybridDefaults {
  readonly deferredTools: ReadonlySet<string>
  readonly hiddenTools?: ReadonlySet<string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    codexHybridDefaults?: CodexHybridDefaults
  }
}

type SystemPromptService = Context['systemPrompt']
type ToolsService = Context['tools']

// Bundled entry points (`hybrid-executor.js`, `tool-policy.js`, `index.js`) load
// separately in DSH; share preset scope defaults on globalThis just like tool ownership.
const HYBRID_DEFAULTS_KEY = Symbol.for('@shuind/dsh-codex-harness:hybrid-defaults:v1')
const HYBRID_HIDDEN_KEY = Symbol.for('@shuind/dsh-codex-harness:hybrid-hidden:v1')

function scopeSetMap(registryKey: symbol): WeakMap<ScopeKey, ReadonlySet<string>> {
  const registry = globalThis as unknown as Record<PropertyKey, unknown>
  const existing = registry[registryKey]
  if (existing instanceof WeakMap) return existing as WeakMap<ScopeKey, ReadonlySet<string>>
  const created = new WeakMap<ScopeKey, ReadonlySet<string>>()
  registry[registryKey] = created
  return created
}

function registerScopedToolSet(
  ctx: Context,
  registryKey: symbol,
  toolNames: ReadonlySet<string>,
  serviceKey?: 'deferredTools' | 'hiddenTools',
): () => void {
  const copy = new Set(toolNames)
  const scope = scopeOf(ctx)
  const disposers: Array<() => void> = []
  if (scope !== undefined) {
    const map = scopeSetMap(registryKey)
    map.set(scope, copy)
    disposers.push(() => {
      if (map.get(scope) === copy) map.delete(scope)
    })
  } else if (serviceKey === 'deferredTools' && typeof (ctx as Partial<Context>).provide === 'function') {
    ctx.provide(CODEX_HYBRID_DEFAULTS_SERVICE, { deferredTools: copy })
  }
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
  }
}

function readScopedToolSet(
  ctx: Context,
  registryKey: symbol,
  serviceKey: 'deferredTools' | 'hiddenTools',
  scope: ScopeKey | undefined = scopeOf(ctx),
): ReadonlySet<string> | undefined {
  const service = typeof (ctx as Partial<Context>).get === 'function'
    ? ctx.get(CODEX_HYBRID_DEFAULTS_SERVICE)
    : undefined
  const direct = service?.[serviceKey]
  if (direct !== undefined) return direct
  if (scope === undefined) return undefined
  const map = scopeSetMap(registryKey)
  for (const key of scopeChainOf(scope)) {
    const entry = map.get(key)
    if (entry !== undefined) return entry
  }
  return undefined
}

/** Register preset-level default deferred tools for descendant Agent and catalog scopes. */
export function registerHybridDefaultDeferredTools(
  ctx: Context,
  deferredTools: ReadonlySet<string>,
): () => void {
  return registerScopedToolSet(ctx, HYBRID_DEFAULTS_KEY, deferredTools, 'deferredTools')
}

/** Read default deferred tool names from ancestor scopes or injected defaults service. */
export function readDefaultDeferredTools(
  ctx: Context,
  scope: ScopeKey | undefined = scopeOf(ctx),
): ReadonlySet<string> | undefined {
  return readScopedToolSet(ctx, HYBRID_DEFAULTS_KEY, 'deferredTools', scope)
}

/** Register preset-level hidden tools for descendant Agent and catalog scopes. */
export function registerHybridDefaultHiddenTools(
  ctx: Context,
  hiddenTools: ReadonlySet<string>,
): () => void {
  return registerScopedToolSet(ctx, HYBRID_HIDDEN_KEY, hiddenTools, 'hiddenTools')
}

/** Read default hidden tool names from ancestor scopes or injected defaults service. */
export function readDefaultHiddenTools(
  ctx: Context,
  scope: ScopeKey | undefined = scopeOf(ctx),
): ReadonlySet<string> | undefined {
  return readScopedToolSet(ctx, HYBRID_HIDDEN_KEY, 'hiddenTools', scope)
}

const MAX_SUMMARY_CHARS = 140

/** Collapse a tool description to a single-line summary capped for prompt stability. */
export function summarizeToolDescription(description: string): string {
  const firstLine = description.trim().split(/\r?\n/u)[0] ?? ''
  const collapsed = firstLine.replace(/\s+/gu, ' ').trim()
  if (collapsed.length === 0) return 'No description provided.'
  const sentenceEnd = collapsed.search(/[.!?。！？](?:\s|$)/u)
  const sentence = sentenceEnd >= 0 ? collapsed.slice(0, sentenceEnd + 1).trim() : collapsed
  if (sentence.length <= MAX_SUMMARY_CHARS) return sentence
  return `${sentence.slice(0, MAX_SUMMARY_CHARS - 3).trimEnd()}...`
}

/** Deterministic catalog guidance naming every deferred tool for `activate_tools`. */
export function buildDeferredToolsGuidance(definitions: readonly ToolDefinition[]): string {
  const sorted = [...definitions].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const lines = [
    `Deferred tools are omitted until activated. Call \`${ACTIVATE_TOOLS_NAME}\` with exact names to enable them on the next model step (do not call a deferred tool in the same step):`,
    ...sorted.map(def => `- \`${def.name}\`: ${summarizeToolDescription(def.description)}`),
  ]
  return lines.join('\n')
}

interface ActivateToolsOutput {
  activated: string[]
  alreadyActive: string[]
  unknown: string[]
}

interface PendingDeferredCompaction {
  compactionId: string
  cold: Set<string>
  hasSummary: boolean
}

function wrapDeferredExecution(
  definition: ToolDefinition,
  onTouch: (name: string) => void,
): ToolDefinition {
  const descriptors = Object.getOwnPropertyDescriptors(definition)
  descriptors.execute = {
    value(this: unknown, args: unknown, exec: Parameters<ToolDefinition['execute']>[1]) {
      onTouch(definition.name)
      return Reflect.apply(definition.execute, this, [args, exec])
    },
    enumerable: true,
    configurable: true,
  }
  return Object.defineProperties(
    Object.create(Object.getPrototypeOf(definition)) as object,
    descriptors,
  ) as ToolDefinition
}

/** Build the per-Agent `activate_tools` capability that flips `when` admission on next step. */
export function createActivateToolsDefinition(
  allowedDefinitions: ReadonlyMap<string, ToolDefinition>,
  activated: Set<string>,
  onTouch?: (name: string) => void,
): ToolDefinition {
  const availableNames = [...allowedDefinitions.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return defineTool({
    name: ACTIVATE_TOOLS_NAME,
    description: 'Activate deferred tools by name so their schemas become callable on the next model step.',
    parameters: {
      names: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Exact deferred tool names to activate (1-32).',
      },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          activated: { type: 'array', required: true, items: { type: 'string' } },
          alreadyActive: { type: 'array', required: true, items: { type: 'string' } },
          unknown: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value): Array<{ type: 'text'; text: string }> => {
        const lines: string[] = []
        if (value.activated.length > 0) {
          lines.push(`Activated for the next step: ${value.activated.join(', ')}. Wait for the next step before calling them.`)
        }
        if (value.alreadyActive.length > 0) {
          lines.push(`Already active: ${value.alreadyActive.join(', ')}.`)
        }
        if (value.unknown.length > 0) {
          const valid = availableNames.length > 0 ? availableNames.join(', ') : '(none)'
          lines.push(`Unknown deferred tools: ${value.unknown.join(', ')}. Available: ${valid}.`)
        }
        return [{ type: 'text', text: lines.length > 0 ? lines.join('\n') : 'No tools activated.' }]
      },
    },
    async execute(args): Promise<ActivateToolsOutput> {
      const names = args.names
      if (!Array.isArray(names) || names.length < 1 || names.length > 32) {
        throw new Error(`${ACTIVATE_TOOLS_NAME}: names must contain between 1 and 32 tool names`)
      }
      const seen = new Set<string>()
      const newlyActivated: string[] = []
      const alreadyActive: string[] = []
      const unknown: string[] = []
      for (const raw of names) {
        if (typeof raw !== 'string') {
          throw new Error(`${ACTIVATE_TOOLS_NAME}: every entry in names must be a string`)
        }
        const name = raw.trim()
        if (name.length === 0) {
          throw new Error(`${ACTIVATE_TOOLS_NAME}: tool names must be non-empty strings`)
        }
        if (seen.has(name)) continue
        seen.add(name)
        if (!allowedDefinitions.has(name)) {
          unknown.push(name)
        } else if (activated.has(name)) {
          onTouch?.(name)
          alreadyActive.push(name)
        } else {
          activated.add(name)
          onTouch?.(name)
          newlyActivated.push(name)
        }
      }
      return { activated: newlyActivated, alreadyActive, unknown }
    },
  })
}

/**
 * Shadow deferred definitions with step-conditional admission and publish
 * `activate_tools` + a deterministic prompt section inside the Agent scope.
 * Cold tools untouched for more than `DEFERRED_RECENT_TURN_WINDOW` turns are
 * reclaimed after local or remote compaction completes.
 */
export function* yieldDeferredToolsOverlay(
  tools: ToolsService,
  systemPrompt: SystemPromptService,
  definitions: readonly ToolDefinition[],
  agent?: Pick<Agent, 'ctx' | 'session'>,
): Generator<() => void, void, unknown> {
  const sorted = [...definitions].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  if (sorted.length === 0) return
  const activated = new Set<string>()
  const allowedDefinitions = new Map<string, ToolDefinition>()
  let currentTurn = typeof (agent?.ctx as Partial<Context> | undefined)?.get === 'function'
    ? (agent!.ctx.get('agents')?.turnBoundaryOf(agent!.session).lastTurn ?? 0)
    : 0
  const lastTouchTurn = new Map<string, number>()
  const touch = (name: string): void => {
    lastTouchTurn.set(name, currentTurn)
  }
  const isCold = (name: string): boolean => {
    const touched = lastTouchTurn.get(name)
    return touched === undefined || currentTurn - touched > DEFERRED_RECENT_TURN_WINDOW
  }
  for (const definition of sorted) {
    allowedDefinitions.set(definition.name, definition)
    yield tools.register(wrapDeferredExecution(definition, touch), { when: () => activated.has(definition.name) })
  }
  yield tools.register(createActivateToolsDefinition(allowedDefinitions, activated, touch))
  yield systemPrompt.section({
    name: 'codex:deferred-tools',
    order: 1018,
    interpolate: false,
    text: buildDeferredToolsGuidance(sorted),
  })
  if (agent !== undefined && typeof (agent.ctx as Partial<Context>).on === 'function') {
    let pending: PendingDeferredCompaction | undefined
    yield agent.ctx.on('session/event', (session, event) => {
      if (session.id !== agent.session.id) return
      if (event.type === 'turn/start') {
        if (typeof event.data.turn === 'number' && event.data.turn > currentTurn) {
          currentTurn = event.data.turn
        }
        return
      }
      if (event.type === 'compaction/start') {
        if (typeof event.data.turn === 'number' && event.data.turn > currentTurn) {
          currentTurn = event.data.turn
        }
        // Snapshot cold candidates before compaction; keep activated unchanged
        // until compaction/end so the compaction request retains its warm KV prefix.
        pending = {
          compactionId: event.data.compactionId,
          cold: new Set([...activated].filter(isCold)),
          hasSummary: false,
        }
        return
      }
      if (event.type === 'compaction/summary') {
        if (pending === undefined || event.data.compactionId !== pending.compactionId) return
        pending.hasSummary = true
        return
      }
      if (event.type === 'compaction/end') {
        if (pending === undefined || event.data.compactionId !== pending.compactionId) return
        const current = pending
        pending = undefined
        if (event.data.error !== undefined || !current.hasSummary) return
        for (const name of current.cold) {
          if (!isCold(name)) continue
          activated.delete(name)
          lastTouchTurn.delete(name)
        }
      }
    }, { global: true })
  }
}

/** Codex-aware `/compact` command with an optional transport preference. */

import type { Context } from '@deepseek-ai/cordis'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { readHostSettings } from '../contracts/settings.ts'
import { OPENAI_CODEX_PROVIDER, OPENAI_CODEX_SETTINGS_NAMESPACE } from '../contracts/ui-contracts.ts'
import { runCodexCompactionMode, type CodexCompactionMode } from './compaction.ts'

const USAGE = 'Usage: /compact [remote|local]'

interface CommandInvocation {
  commandId: string
  agent: Agent
  rawInput: string
  signal: AbortSignal
}

type CommandResult = {
  kind: 'success'
  text?: string
  sourceEventSeq?: number
} | {
  kind: 'error'
  text: string
}

interface CommandDefinition {
  name: string
  description: string
  input: { hint: string }
  handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

interface CommandsRuntime {
  register(definition: CommandDefinition): () => void
}

interface CompactionService {
  compactNow: NonNullable<Context['compaction']>['compactNow']
}

interface AgentPresetsLookup {
  serviceFor?: (agent: unknown, name: string) => unknown
}

type CommandContext = Context & { commands: CommandsRuntime }

/** Convert expected backend failures into the same concise command results as DSH Core. */
function expectedFailure(error: ManualCompactionError): CommandResult {
  switch (error.code) {
    case 'busy':
      return { kind: 'error', text: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.' }
    case 'cancelled':
      return { kind: 'error', text: 'Compaction cancelled.' }
    case 'changed':
      return { kind: 'error', text: 'Compaction could not replace the selected history because it changed. The conversation is unchanged.' }
    case 'summary':
      return { kind: 'error', text: 'Compaction could not produce a useful summary. The conversation is unchanged; the attempt is recorded in the session log.' }
    case 'commit':
      return { kind: 'error', text: 'Compaction did not finish cleanly; inspect the current session state before retrying.' }
    case 'persistence':
      return { kind: 'error', text: 'Compaction finished, but the session could not be saved.' }
    default:
      return { kind: 'error', text: `Unknown compaction failure: ${String(error.code)}` }
  }
}

function modeOf(rawInput: string): CodexCompactionMode | undefined | 'invalid' {
  const value = rawInput.trim().toLowerCase()
  if (value === '') return undefined
  if (value === 'remote' || value === 'local') return value
  return 'invalid'
}

function resolveCompactionService(hostCtx: Context, agent: Agent): CompactionService | undefined {
  const fromPreset = (hostCtx as unknown as {
    get?: (name: string) => AgentPresetsLookup | undefined
  }).get?.('agentPresets')?.serviceFor?.(agent, 'compaction') as CompactionService | undefined
  if (fromPreset?.compactNow !== undefined) return fromPreset

  const fromAgent = (agent as unknown as {
    ctx?: { get?: (name: string) => CompactionService | undefined }
  }).ctx?.get?.('compaction')
  if (fromAgent?.compactNow !== undefined) return fromAgent

  const fromHost = (hostCtx as unknown as {
    get?: (name: string) => CompactionService | undefined
  }).get?.('compaction') ?? (hostCtx as unknown as { compaction?: CompactionService }).compaction
  return fromHost?.compactNow !== undefined ? fromHost : undefined
}

function needsCodexConnectRemoteHint(
  hostCtx: Context,
  agent: Agent,
  mode: CodexCompactionMode | undefined,
): boolean {
  if (mode !== 'remote') return false
  const agentRef = agent as unknown as {
    session?: { requestHeader?: () => { config?: { provider?: unknown } } | undefined }
    model?: { current?: () => { provider?: unknown } | undefined }
  }
  const provider = agentRef.session?.requestHeader?.()?.config?.provider ?? agentRef.model?.current?.()?.provider
  if (provider !== OPENAI_CODEX_PROVIDER) return false
  const descriptors = (hostCtx as unknown as {
    get?: (name: string) => { describe?: () => Array<{ ns: string; value?: unknown }> } | undefined
  }).get?.('settings')?.describe?.()
  if (descriptors === undefined || !descriptors.some(d => d.ns === OPENAI_CODEX_SETTINGS_NAMESPACE)) return false
  const connectSettings = readHostSettings<{ enableNativeCompaction?: boolean }>(
    hostCtx,
    OPENAI_CODEX_SETTINGS_NAMESPACE,
  )
  return connectSettings?.enableNativeCompaction !== true
}

async function ensureCodexConnectRemoteCompaction(
  hostCtx: Context,
  agent: Agent,
  mode: CodexCompactionMode | undefined,
): Promise<boolean> {
  if (!needsCodexConnectRemoteHint(hostCtx, agent, mode)) return false
  const settings = (hostCtx as unknown as {
    get?: (name: string) => { update?: (ns: string, patch: Record<string, unknown>) => Promise<void> } | undefined
  }).get?.('settings')
  if (typeof settings?.update !== 'function') return true
  try {
    await settings.update(OPENAI_CODEX_SETTINGS_NAMESPACE, { enableNativeCompaction: true })
    return needsCodexConnectRemoteHint(hostCtx, agent, mode)
  } catch {
    return true
  }
}

async function executeCompact(hostCtx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const mode = modeOf(invocation.rawInput)
  if (mode === 'invalid') return { kind: 'error', text: USAGE }
  const compaction = resolveCompactionService(hostCtx, invocation.agent)
  if (compaction === undefined) {
    return { kind: 'error', text: 'Compaction is unavailable because no compaction service is configured for this session.' }
  }
  const needsHint = await ensureCodexConnectRemoteCompaction(hostCtx, invocation.agent, mode)
  const compact = () => compaction.compactNow(
    invocation.agent,
    invocation.signal,
    invocation.commandId as Parameters<NonNullable<Context['compaction']>['compactNow']>[2],
  )
  try {
    const result = mode === undefined ? await compact() : await runCodexCompactionMode(mode, compact)
    if (result === null) return { kind: 'success', text: 'No compactable history yet.' }
    const suffix = needsHint
      ? '; enable Native Compaction in Codex Connect settings for remote mode'
      : ''
    return {
      kind: 'success',
      text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens${suffix}).`,
      sourceEventSeq: result.summarySeq,
    }
  } catch (error) {
    if (invocation.signal.aborted) return { kind: 'error', text: 'Compaction cancelled.' }
    if (error instanceof ManualCompactionError) return expectedFailure(error)
    throw error
  }
}

function createCompactDefinition(hostCtx: Context, active: Set<Promise<CommandResult>>): CommandDefinition {
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const operation = executeCompact(hostCtx, invocation)
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    operation.then(retire, retire)
    return operation
  }
  return {
    name: 'compact',
    description: 'Compact older conversation history, optionally using remote or local mode',
    input: { hint: '[remote|local]' },
    handler,
  }
}

function mountPerAgentCommands(commandsCtx: Context): () => Promise<void> {
  const active = new Set<Promise<CommandResult>>()
  const disposers = new Map<object, () => void>()
  const definition = createCompactDefinition(commandsCtx, active)
  const attach = (agent: Agent | undefined): void => {
    if (agent === undefined || typeof agent !== 'object' || disposers.has(agent)) return
    const agentCommands = (agent as unknown as {
      ctx?: { get?: (name: string) => CommandsRuntime | undefined }
    }).ctx?.get?.('commands')
    if (agentCommands?.register === undefined) return
    disposers.set(agent, agentCommands.register(definition))
  }
  const existing = (commandsCtx as unknown as {
    get?: (name: string) => { list?: () => readonly Agent[] } | undefined
  }).get?.('agents')?.list?.() ?? []
  for (const agent of existing) attach(agent)

  const offCreated = commandsCtx.on(
    'agent/created',
    (({ agent }: { agent: Agent }) => { attach(agent) }) as never,
  ) as unknown as (() => void) | undefined
  const offDisposed = commandsCtx.on(
    'agent/disposed',
    (({ agent }: { agent: Agent }) => {
      const off = disposers.get(agent)
      disposers.delete(agent)
      off?.()
    }) as never,
  ) as unknown as (() => void) | undefined

  return async () => {
    offCreated?.()
    offDisposed?.()
    for (const off of disposers.values()) off()
    disposers.clear()
    await Promise.allSettled(active)
  }
}

/** Register `/compact [remote|local]` on each live and future Agent scope across all presets. */
export function installGlobalCompactCommand(ctx: Context): void {
  if (typeof (ctx as { on?: unknown }).on !== 'function') return
  if (typeof (ctx as { inject?: unknown }).inject === 'function') {
    ctx.inject(['commands' as never], ((commandsCtx: Context) => {
      const cleanup = mountPerAgentCommands(commandsCtx)
      ;(commandsCtx as { effect?: (fn: () => () => Promise<void>, label?: string) => void }).effect?.(
        () => cleanup,
        'codex: per-agent /compact command',
      )
    }) as never)
    return
  }
  if ((ctx as unknown as { get?: (name: string) => unknown }).get?.('commands') !== undefined) {
    const cleanup = mountPerAgentCommands(ctx)
    ;(ctx as { effect?: (fn: () => () => Promise<void>, label?: string) => void }).effect?.(
      () => cleanup,
      'codex: per-agent /compact command',
    )
  }
}

/** Replace the Core command inside the Codex compaction scope. */
export function apply(ctx: Context): void {
  const commands = (ctx as CommandContext).commands
  const active = new Set<Promise<CommandResult>>()
  const definition = createCompactDefinition(ctx, active)
  ctx.effect(function* () {
    yield async () => { await Promise.allSettled(active) }
    yield commands.register(definition)
  }, 'codex compact command lifecycle')
}

export const name = 'compact-command'
export const inject = ['commands', 'compaction']

export default { name, inject, apply }

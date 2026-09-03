/** Codex-aware `/compact` command with an optional transport preference. */

import type { Context } from '@deepseek-ai/cordis'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
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

interface CommandsRuntime {
  register(definition: {
    name: string
    description: string
    input: { hint: string }
    handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
  }): () => void
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

async function executeCompact(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const mode = modeOf(invocation.rawInput)
  if (mode === 'invalid') return { kind: 'error', text: USAGE }
  const compact = () => ctx.compaction.compactNow(
    invocation.agent,
    invocation.signal,
    invocation.commandId as Parameters<NonNullable<Context['compaction']>['compactNow']>[2],
  )
  try {
    const result = mode === undefined ? await compact() : await runCodexCompactionMode(mode, compact)
    if (result === null) return { kind: 'success', text: 'No compactable history yet.' }
    return {
      kind: 'success',
      text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`,
      sourceEventSeq: result.summarySeq,
    }
  } catch (error) {
    if (invocation.signal.aborted) return { kind: 'error', text: 'Compaction cancelled.' }
    if (error instanceof ManualCompactionError) return expectedFailure(error)
    throw error
  }
}

/** Replace the Core command inside the Codex compaction scope. */
export function apply(ctx: Context): void {
  const commands = (ctx as CommandContext).commands
  const active = new Set<Promise<CommandResult>>()
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const operation = executeCompact(ctx, invocation)
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    operation.then(retire, retire)
    return operation
  }
  ctx.effect(function* () {
    yield async () => { await Promise.allSettled(active) }
    yield commands.register({
      name: 'compact',
      description: 'Compact older conversation history, optionally using remote or local mode',
      input: { hint: '[remote|local]' },
      handler,
    })
  }, 'codex compact command lifecycle')
}

export const name = 'compact-command'
export const inject = ['commands', 'compaction']

export default { name, inject, apply }

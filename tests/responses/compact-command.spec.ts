import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime, { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CODEX_SETTINGS_ENTRY } from '../../src/contracts/settings.ts'
import { apply as applyHarness } from '../../src/entries/index.ts'
import { codexCompactionMode } from '../../src/entries/compaction.ts'
import { apply, installGlobalCompactCommand } from '../../src/entries/compact-command.ts'
import { installSmallWindowCompaction } from '../../src/presets/small-window-compaction.ts'

function mount() {
  let definition: {
    handler(invocation: { commandId: string; agent: never; rawInput: string; signal: AbortSignal }): Promise<unknown>
  } | undefined
  let mode: string | undefined
  const ctx = {
    commands: {
      register(next: typeof definition): () => void {
        definition = next
        return () => {}
      },
    },
    compaction: {
      compactNow: async () => {
        mode = codexCompactionMode()
        return { shadowedSeqs: [1, 2], shadowedTokenCount: 100, summarySeq: 3 }
      },
    },
    effect(factory: () => Generator<unknown, void, unknown>): void {
      const iterator = factory()
      iterator.next()
      iterator.next()
    },
  } as unknown as Context
  apply(ctx)
  if (definition === undefined) throw new Error('compact command was not registered')
  return { handler: definition.handler, getMode: () => mode }
}

const invocation = (rawInput: string) => ({
  commandId: 'cmd-test',
  agent: {} as never,
  rawInput,
  signal: new AbortController().signal,
})

describe('Codex compact command', () => {
  it('shares explicit mode across separately evaluated plugin entry modules', async () => {
    const duplicateEntry = await import('../../src/entries/compaction.ts?duplicate-entry')
    let observed: string | undefined
    await duplicateEntry.runCodexCompactionMode('remote', async () => {
      observed = codexCompactionMode()
    })
    expect(observed).toBe('remote')
  })

  it.each([
    ['remote', 'remote'],
    [' local ', 'local'],
  ])('passes %s as the compaction preference', async (input, expected) => {
    const command = mount()
    await expect(command.handler(invocation(input))).resolves.toMatchObject({
      kind: 'success',
      text: 'Compacted 2 history items (~100 tokens).',
    })
    expect(command.getMode()).toBe(expected)
  })

  it('keeps the setting-selected mode for an argument-free command', async () => {
    const command = mount()
    await expect(command.handler(invocation(''))).resolves.toMatchObject({ kind: 'success' })
    expect(command.getMode()).toBeUndefined()
  })

  it('rejects unsupported mode arguments without starting compaction', async () => {
    const command = mount()
    await expect(command.handler(invocation('automatic'))).resolves.toEqual({
      kind: 'error',
      text: 'Usage: /compact [remote|local]',
    })
    expect(command.getMode()).toBeUndefined()
  })

  it('shadows preset /compact per agent, resolves isolated compaction, and cleans up across remounts', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    const presetKey = {}
    const presetScope = createScope(ctx, presetKey)
    presetScope.ctx.get('commands')!.register({
      name: 'compact',
      description: 'Core /compact',
      handler: inv => inv.rawInput.trim()
        ? { kind: 'error', text: 'Usage: /compact (no arguments)' }
        : { kind: 'success', text: 'core' },
    })

    const modes: Array<string | undefined> = []
    const compactNow = vi.fn(async () => {
      modes.push(codexCompactionMode())
      return { shadowedSeqs: [1], shadowedTokenCount: 42, summarySeq: 2 }
    })
    const liveAgents: Array<{ session: Session; ctx: Context }> = []
    ctx.provide('agents' as never, { list: () => liveAgents } as never)
    ctx.provide('agentPresets' as never, {
      serviceFor: (_agent: unknown, name: string) => name === 'compaction' ? { compactNow } : undefined,
    } as never)

    const createAgent = (id: string) => {
      const agent = { session: Session.create(SessionId(id)), ctx: undefined as unknown as Context }
      const agentScope = createScope(ctx, agent, { parent: presetKey })
      agent.ctx = agentScope.ctx
      liveAgents.push(agent)
      return agent
    }

    const firstAgent = createAgent('compact-shadow-1')
    const mountGlobal = () => ctx.plugin(hostCtx => { installGlobalCompactCommand(hostCtx) })
    const fiber1 = await mountGlobal()
    const signal = new AbortController().signal

    await expect(ctx.commands.execute(firstAgent as never, '/compact remote', [], signal)).resolves.toMatchObject({
      result: { kind: 'success', text: 'Compacted 1 history items (~42 tokens).' },
    })
    await expect(ctx.commands.execute(firstAgent as never, '/compact', [], signal)).resolves.toMatchObject({
      result: { kind: 'success', text: 'Compacted 1 history items (~42 tokens).' },
    })

    const secondAgent = createAgent('compact-shadow-2')
    await ctx.serial('agent/created' as never, { agent: secondAgent } as never)
    await expect(ctx.commands.execute(secondAgent as never, '/compact local', [], signal)).resolves.toMatchObject({
      result: { kind: 'success', text: 'Compacted 1 history items (~42 tokens).' },
    })
    expect(modes).toEqual(['remote', undefined, 'local'])

    // Disposing firstAgent restores preset fallback on a recreated view or cleans up cleanly.
    await ctx.serial('agent/disposed' as never, { agent: firstAgent } as never)
    await expect(ctx.commands.execute(firstAgent as never, '/compact remote', [], signal)).resolves.toMatchObject({
      result: { kind: 'error', text: 'Usage: /compact (no arguments)' },
    })

    await fiber1.dispose()
    await expect(ctx.commands.execute(secondAgent as never, '/compact remote', [], signal)).resolves.toMatchObject({
      result: { kind: 'error', text: 'Usage: /compact (no arguments)' },
    })

    // Re-mounting attaches cleanly without duplicate command errors.
    const fiber2 = await mountGlobal()
    await expect(ctx.commands.execute(secondAgent as never, '/compact remote', [], signal)).resolves.toMatchObject({
      result: { kind: 'success', text: 'Compacted 1 history items (~42 tokens).' },
    })
    await fiber2.dispose()
    await ctx.fiber.dispose()
  })

  it('neutralizes compaction instruction in global llm/stream when /compact local runs on BasicCompactionEngine', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const seenTexts: string[] = []
    class CaptureAdapter extends LlmAdapter {
      override resolveModel(provider: string, model: string) {
        return Promise.resolve({ provider, id: model, name: model })
      }

      override async * stream(options: Parameters<LlmAdapter['stream']>[0]): AsyncIterable<StreamChunk> {
        const lastBlock = options.messages.at(-1)?.content[0]
        seenTexts.push(lastBlock?.type === 'text' ? lastBlock.text : '')
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['openai-codex'], new CaptureAdapter())

    const compact = {
      compactNow: async () => {
        const baseOptions = {
          provider: 'openai-codex',
          model: 'gpt-6.1-sol',
          purpose: 'compaction' as const,
          messages: [
            { role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] },
            { role: 'user' as const, content: [{ type: 'text' as const, text: 'You are now acting as a compaction engine...' }] },
          ],
        }
        for await (const _ of ctx.llm.stream(baseOptions as never)) { /* drain */ }
        for await (const _ of ctx.llm.stream(Object.freeze({
          ...baseOptions,
          messages: baseOptions.messages.map(m => ({ ...m })),
        }) as never)) { /* drain */ }
        return { shadowedSeqs: [1], shadowedTokenCount: 10, summarySeq: 2 }
      },
    }
    await ctx.plugin(CommandRuntime)
    ctx.provide('tools' as never, { register: () => () => {} } as never)
    ctx.provide('systemPrompt' as never, { section: () => () => {} } as never)
    ctx.provide('shell' as never, {} as never)
    ctx.provide('fs' as never, { sandboxMode: undefined } as never)
    ctx.provide('credentials' as never, { resolve: async () => undefined } as never)
    ctx.provide('settings' as never, { describe: () => [] } as never)
    ctx.provide('compaction' as never, compact as never)

    await ctx.plugin(hostCtx => {
      applyHarness(hostCtx as never, { globalEnhancements: true, codexCore: false })
    })
    const agent = { session: Session.create(SessionId('compact-local-stream')), ctx: undefined as unknown as Context }
    agent.ctx = createScope(ctx, agent).ctx
    await ctx.serial('agent/created' as never, { agent } as never)

    await expect(ctx.commands.execute(agent as never, '/compact local', [], new AbortController().signal))
      .resolves.toMatchObject({ result: { kind: 'success' } })
    expect(seenTexts).toEqual([
      '\nYou are now acting as a compaction engine...',
      '\nYou are now acting as a compaction engine...',
    ])
    await ctx.fiber.dispose()
  })

  it('auto-enables Codex Connect native compaction on /compact remote when writable, and adds hint when read-only', async () => {
    let enableNativeCompaction = false
    const calls: string[] = []
    const makeCtx = (updateImpl?: (ns: string, patch: Record<string, unknown>) => Promise<void>) => {
      let registered: { handler: (inv: ReturnType<typeof invocation>) => Promise<unknown> } | undefined
      const ctx = {
        get: (name: string) => name === 'settings'
          ? {
            describe: () => [{ ns: 'llm-openai-codex', value: { enableNativeCompaction } }],
            ...(updateImpl === undefined ? {} : { update: updateImpl }),
          }
          : undefined,
        commands: {
          register: (def: typeof registered) => { registered = def; return () => {} },
        },
        compaction: {
          compactNow: async () => {
            calls.push(`compactNow:${enableNativeCompaction}`)
            return { shadowedSeqs: [1], shadowedTokenCount: 50, summarySeq: 2 }
          },
        },
        effect: (fn: () => Generator<unknown, void, unknown>) => { const it = fn(); it.next(); it.next() },
      } as unknown as Context
      apply(ctx)
      return registered!
    }

    const agent = {
      session: { requestHeader: () => ({ config: { provider: 'openai-codex', model: 'gpt-6.1-sol' } }) },
    }
    const readOnlyCmd = makeCtx(async () => { throw new Error('read-only') })
    await expect(readOnlyCmd.handler({ ...invocation('remote'), agent: agent as never })).resolves.toMatchObject({
      kind: 'success',
      text: 'Compacted 1 history items (~50 tokens; enable Native Compaction in Codex Connect settings for remote mode).',
    })

    const writableCmd = makeCtx(async (ns, patch) => {
      expect(ns).toBe('llm-openai-codex')
      expect(patch).toEqual({ enableNativeCompaction: true })
      calls.push('settings.update:true')
      enableNativeCompaction = true
    })
    await expect(writableCmd.handler({ ...invocation('remote'), agent: agent as never })).resolves.toMatchObject({
      kind: 'success',
      text: 'Compacted 1 history items (~50 tokens).',
    })
    expect(calls).toEqual(['compactNow:false', 'settings.update:true', 'compactNow:true'])
  })

  it('resolves isolated compaction and toolResultPruner via agentPresets.serviceFor in small-window bridge', async () => {
    const ctx = new Context()
    const session = Session.create(SessionId('small-window-isolated'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', { header: { config: { provider: 'openai-codex', model: 'gpt-6.1-sol' } }, reason: 'initial' })
    session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } } as never, { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'b' }], source: { kind: 'model', provider: 'openai-codex', model: 'gpt-6.1-sol' } }, stream: [] } as never, { surfaceOp: 'append' })

    const compactRegion = vi.fn(async () => {
      totalTokens = 10_000
      return {}
    })
    const pruneSession = vi.fn()
    let totalTokens = 60_000
    const agentScope = createScope(ctx, {})
    const agent = { ctx: agentScope.ctx, session }

    ctx.provide('agentPresets' as never, {
      serviceFor: (_target: unknown, name: string) => name === 'compaction'
        ? { compactRegion }
        : name === 'toolResultPruner'
          ? { pruneSession }
          : undefined,
    } as never)
    ctx.provide('llm' as never, { resolveModelInfo: async () => ({ context: { contextWindow: 64_000 } }) } as never)
    ctx.provide('tokenMeter' as never, {
      measure: () => ({
        logRevision: session.seq,
        baseline: { kind: 'estimated', tokens: 0 },
        surfaceDeltaTokens: totalTokens,
        totalTokens,
        surfaceTokens: totalTokens,
        nodes: session.surface.nodes.map(seq => ({ seq, tokens: totalTokens / 2, heuristicTokens: totalTokens / 2 })),
      }),
    } as never)

    installSmallWindowCompaction(ctx, () => CODEX_SETTINGS_ENTRY, new WeakMap())
    await ctx.waterfall('agent/pre-step' as never, { agent, signal: new AbortController().signal } as never, async () => ({ kind: 'continue' }))

    expect(pruneSession).toHaveBeenCalledOnce()
    expect(compactRegion).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })
})
